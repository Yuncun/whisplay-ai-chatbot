/**
 * OpenClaw WebSocket LLM Plugin
 *
 * Persistent WebSocket connection to the OpenClaw gateway.
 * Replaces the stateless HTTP/SSE openclaw-llm.ts with a bi-directional
 * channel that gives: persistent sessions, real-time agent events,
 * and gateway-pushed commands.
 *
 * Protocol: req/res/event frames over ws://
 * V3 device auth with Ed25519 signatures.
 *
 * .env config:
 *   OPENCLAW_BASE_URL=http://localhost:18789
 *   OPENCLAW_TOKEN=your-token
 *   OPENCLAW_AGENT_ID=claudia
 *   OPENCLAW_DEVICE_IDENTITY_PATH=.whisplay-device.json  (optional, defaults to project root)
 *   OPENCLAW_RESPONSE_TIMEOUT_MS=120000  (optional, default 2 min)
 *   OPENCLAW_STALE_TIMEOUT_MS=60000  (optional, silence before ping probe, default 60s)
 *   OPENCLAW_PONG_TIMEOUT_MS=10000  (optional, max wait for pong reply, default 10s)
 */

import WebSocket from "ws";
import crypto, { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { Message } from "../../type";
import { ChatWithLLMStreamFunction } from "../interface";
import { display } from "../../device/display";
import dotEnv from "dotenv";

dotEnv.config();

const baseUrl = process.env.OPENCLAW_BASE_URL || "http://localhost:18789";
const wsUrl = baseUrl.replace(/^http/, "ws");
const token = process.env.OPENCLAW_TOKEN || "";
const defaultAgentId = process.env.OPENCLAW_AGENT_ID || "claudia";
let currentAgentId = defaultAgentId;
let sessionKey = `agent:${currentAgentId}:main`;
const responseTimeoutMs = parseInt(process.env.OPENCLAW_RESPONSE_TIMEOUT_MS || "120000", 10);

// ── Connection liveness detection ───────────────────────────────────────
// The gateway sends periodic events (tick, health, presence) as application-
// level keepalives. We track when we last received *any* message. If silence
// exceeds STALE_TIMEOUT_MS we send a WebSocket-level ping frame as a probe.
// If the pong doesn't come back within PONG_TIMEOUT_MS, the connection is
// truly dead (e.g. phone hotspot lost cellular, Tailscale tunnel stale) and
// we tear it down to trigger reconnection.
//
// This catches the "connected to WiFi but no internet" scenario where the
// TCP socket looks open but nothing gets through — the most common silent
// failure when using a mobile hotspot.
const staleTimeoutMs = parseInt(process.env.OPENCLAW_STALE_TIMEOUT_MS || "60000", 10);
const pongTimeoutMs = parseInt(process.env.OPENCLAW_PONG_TIMEOUT_MS || "10000", 10);
let lastMessageAt = 0;
let stalenessCheckInterval: NodeJS.Timeout | null = null;
let pongTimer: NodeJS.Timeout | null = null;

// Load device identity for gateway pairing
const deviceIdentityPath = process.env.OPENCLAW_DEVICE_IDENTITY_PATH
  || path.resolve(__dirname, "../../../.whisplay-device.json");
const deviceIdentity = JSON.parse(fs.readFileSync(deviceIdentityPath, "utf8"));

// Connection state
let ws: WebSocket | null = null;
let connected = false;
let connecting = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const VERSION = "0.8.0";

// Request tracking
let requestIdCounter = 0;
const pendingRequests = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason: any) => void }
>();

// Agent event handler for current streaming response
let agentEventHandler: ((payload: any) => void) | null = null;
let responseTimer: NodeJS.Timeout | null = null;

// Challenge nonce from gateway
let challengeNonce: string | null = null;

/** Start the periodic staleness check. Called once after successful connect. */
function startStalenessCheck(): void {
  stopStalenessCheck();
  lastMessageAt = Date.now();
  stalenessCheckInterval = setInterval(() => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;

    const silenceMs = Date.now() - lastMessageAt;
    if (silenceMs < staleTimeoutMs) return;

    // No messages for staleTimeoutMs — probe with a WS ping
    if (pongTimer) return; // already waiting for a pong
    console.log(`[OpenClaw-WS] No messages for ${Math.round(silenceMs / 1000)}s, sending ping probe`);
    try {
      ws.ping();
    } catch {
      // ping failed — socket is already broken
      ws?.close();
      return;
    }

    // If pong doesn't arrive in time, the connection is dead
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (connected && ws) {
        console.warn(`[OpenClaw-WS] Pong timeout after ${pongTimeoutMs}ms — connection dead, closing`);
        ws.close();
      }
    }, pongTimeoutMs);
  }, 15000); // check every 15s
}

/** Stop the staleness check and cancel any pending pong timer. */
function stopStalenessCheck(): void {
  if (stalenessCheckInterval) {
    clearInterval(stalenessCheckInterval);
    stalenessCheckInterval = null;
  }
  if (pongTimer) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

function nextId(): string {
  return String(++requestIdCounter);
}

function sendRequest(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket not connected"));
      return;
    }
    const id = nextId();
    const frame = JSON.stringify({ type: "req", id, method, params });
    pendingRequests.set(id, { resolve, reject });
    ws.send(frame);
  });
}

/** Clean up agent event handler and response timeout from a previous turn. */
function cleanupAgentHandler(): void {
  agentEventHandler = null;
  if (responseTimer) {
    clearTimeout(responseTimer);
    responseTimer = null;
  }
}

function handleMessage(raw: string): void {
  // Any incoming message proves the connection is alive — reset staleness timer
  lastMessageAt = Date.now();

  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "res") {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.payload || {});
      } else {
        pending.reject(new Error(msg.payload?.message || msg.error?.message || `Request ${msg.id} failed`));
      }
    }
    return;
  }

  if (msg.type === "event") {
    if (msg.event === "agent" && agentEventHandler) {
      agentEventHandler(msg.payload);
    }
    // Agent switch pushed from gateway (e.g. triggered by another agent)
    if (msg.event === "agent_switch" && msg.payload) {
      const { agent, voice, tts_instructions } = msg.payload;
      if (agent) {
        switchAgent(agent, voice, tts_instructions);
      }
    }
    // tick/health/presence events are keepalives — no action needed
    return;
  }
}

function buildDeviceAuth(nonce: string): any {
  const signedAtMs = Date.now();
  const spki = crypto.createPublicKey(deviceIdentity.publicKeyPem)
    .export({ type: "spki", format: "der" });
  const rawKey = (spki as Buffer).subarray(12);
  const publicKeyB64Url = rawKey.toString("base64url");

  const payload = [
    "v3",
    deviceIdentity.deviceId,
    "webchat",       // client.id
    "webchat",       // client.mode
    "operator",      // role
    "operator.read,operator.write",  // scopes
    String(signedAtMs),
    token,           // gateway auth token
    nonce,           // from connect.challenge
    "linux",         // platform
    "",              // deviceFamily
  ].join("|");

  const signature = crypto.sign(
    null,
    Buffer.from(payload, "utf8"),
    crypto.createPrivateKey(deviceIdentity.privateKeyPem),
  ).toString("base64url");

  return {
    id: deviceIdentity.deviceId,
    publicKey: publicKeyB64Url,
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}

async function sendConnectFrame(): Promise<any> {
  const nonce = challengeNonce || randomUUID();
  return sendRequest("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "webchat",
      displayName: "WhisPlay",
      version: VERSION,
      platform: "linux",
      mode: "webchat",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    auth: { token },
    device: buildDeviceAuth(nonce),
  });
}

function ensureConnection(): Promise<void> {
  if (connected && ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return doConnect();
}

function doConnect(): Promise<void> {
  if (connecting) {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (connected) {
          clearInterval(check);
          resolve();
        } else if (!connecting) {
          clearInterval(check);
          reject(new Error("Connection failed"));
        }
      }, 100);
    });
  }

  connecting = true;

  return new Promise<void>((resolve, reject) => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    console.log(`[OpenClaw-WS] Connecting to ${wsUrl}`);
    ws = new WebSocket(wsUrl, { headers: { Origin: baseUrl } });

    let connectResolve = resolve;
    let connectReject = reject;

    ws.on("open", () => {
      console.log("[OpenClaw-WS] Socket open, waiting for connect.challenge");
    });

    // Pong replies to our ping probes — proves the connection is alive
    ws.on("pong", () => {
      lastMessageAt = Date.now();
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
    });

    ws.on("message", async (data) => {
      const raw = data.toString();
      // Any incoming data proves liveness (covers challenge + normal messages)
      lastMessageAt = Date.now();

      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }

      // Handle connect.challenge before normal routing
      if (msg.type === "event" && msg.event === "connect.challenge") {
        challengeNonce = msg.payload.nonce;
        console.log("[OpenClaw-WS] Got challenge, sending connect frame with device auth");
        try {
          const payload = await sendConnectFrame();
          connected = true;
          connecting = false;
          reconnectDelay = 1000;
          console.log("[OpenClaw-WS] Connected successfully (protocol 3, device paired)");
          display({ gateway_connected: true });
          startStalenessCheck();
          connectResolve();
        } catch (err: any) {
          console.error(`[OpenClaw-WS] Connect frame rejected: ${err.message}`);
          connecting = false;
          ws?.close();
          connectReject(err);
        }
        return;
      }

      // Normal message handling
      handleMessage(raw);
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString() || "";
      console.log(`[OpenClaw-WS] Closed: ${code} ${reasonStr}`);
      connected = false;
      connecting = false;
      display({ gateway_connected: false });
      stopStalenessCheck();

      // Clean up any in-flight agent response
      cleanupAgentHandler();

      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error("WebSocket closed"));
      }
      pendingRequests.clear();

      if (code === 1008) {
        console.error(`[OpenClaw-WS] Auth/pairing error: ${reasonStr}`);
        return;
      }

      scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error(`[OpenClaw-WS] Error: ${err.message}`);
      if (connecting) {
        connecting = false;
        connectReject(err);
      }
    });
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  // Increase delay for next attempt (single increment, not double)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  console.log(`[OpenClaw-WS] Reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect().catch(() => {
      // delay already incremented above; scheduleReconnect will be called
      // again from the close handler if needed
    });
  }, delay);
}

// --- Public API ---

const chatWithLLMStream: ChatWithLLMStreamFunction = async (
  inputMessages: Message[] = [],
  partialCallback: (partialAnswer: string) => void,
  endCallback: () => void,
  _partialThinkingCallback?: (partialThinking: string) => void,
  _invokeFunctionCallback?: (functionName: string, result?: string) => void,
): Promise<void> => {
  try {
    await ensureConnection();
  } catch (err: any) {
    console.error(`[OpenClaw-WS] Cannot connect: ${err.message}`);
    partialCallback("Sorry, I can't reach OpenClaw right now.");
    endCallback();
    return;
  }

  const userMessage = inputMessages.filter((m) => m.role === "user").pop();
  if (!userMessage?.content) {
    endCallback();
    return;
  }

  // Clean up any stale handler from a previous abandoned turn
  cleanupAgentHandler();

  let fullAnswer = "";
  let ended = false;

  const finishResponse = (): void => {
    if (ended) return;
    ended = true;
    cleanupAgentHandler();
    endCallback();
  };

  agentEventHandler = (payload: any) => {
    if (ended) return;

    const { stream, data } = payload;

    if (stream === "assistant" && data?.delta) {
      fullAnswer += data.delta;
      partialCallback(data.delta);
    }

    if (stream === "lifecycle" && data?.event === "end") {
      finishResponse();
      console.log(`[OpenClaw-WS] Response complete (${fullAnswer.length} chars)`);
    }
  };

  // Response timeout: if the agent never finishes, clean up and signal end
  responseTimer = setTimeout(() => {
    if (!ended) {
      console.warn(`[OpenClaw-WS] Response timeout after ${responseTimeoutMs}ms`);
      if (!fullAnswer) {
        partialCallback("Sorry, the response timed out.");
      }
      finishResponse();
    }
  }, responseTimeoutMs);

  try {
    console.log(`[OpenClaw-WS] chat.send (session=${sessionKey})`);
    await sendRequest("chat.send", {
      sessionKey,
      message: userMessage.content,
      idempotencyKey: randomUUID(),
    });
  } catch (err: any) {
    console.error(`[OpenClaw-WS] chat.send failed: ${err.message}`);
    if (!ended) {
      partialCallback("Sorry, message send failed.");
      finishResponse();
    }
  }
};

const resetChatHistory = (): void => {
  console.log("[OpenClaw-WS] Chat history is managed by the gateway");
};

export let currentMode = "claudia";
export const setOpenClawMode = (mode: string): void => {
  currentMode = mode;
  display({ mode_label: mode });
  if (mode !== defaultAgentId && connected) {
    sendRequest("chat.inject", {
      sessionKey,
      message: `[MODE SWITCH] Active mode: ${mode}`,
    }).catch((err) => {
      console.error(`[OpenClaw-WS] chat.inject failed: ${err.message}`);
    });
  }
};

/**
 * Per-agent voice configuration. Maps agent IDs to their preferred TTS
 * voice and speaking style. When switching agents, the TTS automatically
 * updates to match. Agents not in this map get the default voice.
 *
 * Uses gpt-4o-mini-tts model (supports instructions param) when
 * instructions are specified, falls back to tts-1 otherwise.
 */
const agentVoiceMap: Record<string, { voice: string; instructions?: string }> = {
  diane: {
    voice: "fable",
    instructions: "Speak with a refined British accent. Dry, understated, sharp wit. Don't overdo it.",
  },
  // claudia uses the default voice (nova on tts-1) — no entry needed
};

/**
 * Switch the active agent session. Changes which OpenClaw agent the
 * WhisPlay talks to and updates the TTS voice to match.
 *
 * @param agentId   - The agent to switch to (e.g. "diane", "claudia")
 * @param voice     - Optional voice override (takes precedence over agentVoiceMap)
 * @param instructions - Optional TTS instructions override
 */
export const switchAgent = (agentId: string, voice?: string, instructions?: string): void => {
  const previousAgent = currentAgentId;
  currentAgentId = agentId;
  sessionKey = `agent:${agentId}:main`;
  currentMode = agentId;
  console.log(`[OpenClaw-WS] Agent switch: ${previousAgent} → ${agentId} (session=${sessionKey})`);

  // Update display label
  display({ mode_label: agentId });

  // Update TTS voice: explicit params > agentVoiceMap > default
  const { setTTSInstructions } = require("../openai/openai-tts");
  const voiceConfig = agentVoiceMap[agentId];
  const finalVoice = voice || voiceConfig?.voice || "";
  const finalInstructions = instructions || voiceConfig?.instructions || "";
  if (finalVoice || finalInstructions) {
    setTTSInstructions(finalInstructions, finalVoice);
  } else {
    // Reset to default voice (no override, no instructions)
    setTTSInstructions("");
  }
};

export default {
  chatWithLLMStream,
  resetChatHistory,
  switchAgent,
};
