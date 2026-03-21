/**
 * OpenClaw WebSocket LLM Plugin
 *
 * Persistent WebSocket connection to the OpenClaw gateway.
 * Replaces the stateless HTTP/SSE openclaw-llm.ts with a bi-directional
 * channel that gives: persistent sessions, real-time agent events,
 * and gateway-pushed commands.
 *
 * Protocol: req/res/event frames over ws://
 * See Diane's spec for full protocol details.
 *
 * .env config:
 *   OPENCLAW_BASE_URL=http://100.104.104.9:18789
 *   OPENCLAW_TOKEN=your-token
 *   OPENCLAW_AGENT_ID=claudia
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";
import { Message } from "../../type";
import { ChatWithLLMStreamFunction } from "../interface";
import dotEnv from "dotenv";

dotEnv.config();

const baseUrl = process.env.OPENCLAW_BASE_URL || "http://localhost:18789";
const wsUrl = baseUrl.replace(/^http/, "ws");
const token = process.env.OPENCLAW_TOKEN || "";
const agentId = process.env.OPENCLAW_AGENT_ID || "claudia";
const sessionKey = `agent:${agentId}:main`;

// Connection state
let ws: WebSocket | null = null;
let connected = false;
let connecting = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const VERSION = "0.6.0";

// Request tracking
let requestIdCounter = 0;
const pendingRequests = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason: any) => void }
>();

// Agent event handler for current streaming response
let agentEventHandler: ((payload: any) => void) | null = null;

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

function handleMessage(raw: string): void {
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
        pending.reject(new Error(msg.payload?.error || `Request ${msg.id} failed`));
      }
    }
    return;
  }

  if (msg.type === "event") {
    if (msg.event === "agent" && agentEventHandler) {
      agentEventHandler(msg.payload);
    }
    // tick events are keepalives — no action needed
    return;
  }
}

async function sendConnectFrame(): Promise<any> {
  return sendRequest("connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "whisplay",
      displayName: "WhisPlay",
      version: VERSION,
      platform: "linux",
      mode: "webchat",
    },
    auth: { token },
    features: {
      methods: ["chat.send", "chat.history", "chat.abort"],
      events: ["agent", "chat", "tick"],
    },
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
    // Wait for in-flight connection
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
    ws = new WebSocket(wsUrl);

    ws.on("open", async () => {
      console.log("[OpenClaw-WS] Socket open, sending connect frame");
      try {
        const payload = await sendConnectFrame();
        connected = true;
        connecting = false;
        reconnectDelay = 1000;
        console.log("[OpenClaw-WS] Connected successfully");
        resolve();
      } catch (err: any) {
        console.error(`[OpenClaw-WS] Connect frame rejected: ${err.message}`);
        connecting = false;
        ws?.close();
        reject(err);
      }
    });

    ws.on("message", (data) => {
      handleMessage(data.toString());
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString() || "";
      console.log(`[OpenClaw-WS] Closed: ${code} ${reasonStr}`);
      connected = false;
      connecting = false;

      // Reject any pending requests
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error("WebSocket closed"));
      }
      pendingRequests.clear();

      // Don't reconnect on auth/pairing errors
      if (code === 1008) {
        console.error(`[OpenClaw-WS] Pairing required — ask Diane to approve this device`);
        return;
      }

      scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error(`[OpenClaw-WS] Error: ${err.message}`);
      // close handler will fire next and handle reconnection
      if (connecting) {
        connecting = false;
        reject(err);
      }
    });
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  console.log(`[OpenClaw-WS] Reconnecting in ${reconnectDelay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect().catch(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    });
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
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

  // Extract the latest user message
  const userMessage = inputMessages
    .filter((m) => m.role === "user")
    .pop();

  if (!userMessage?.content) {
    endCallback();
    return;
  }

  let fullAnswer = "";
  let ended = false;

  // Set up agent event handler for this request
  agentEventHandler = (payload: any) => {
    if (ended) return;

    const { stream, data } = payload;

    if (stream === "assistant" && data?.delta) {
      fullAnswer += data.delta;
      partialCallback(data.delta);
    }

    if (stream === "lifecycle" && data?.event === "end") {
      ended = true;
      agentEventHandler = null;
      endCallback();
      console.log(`[OpenClaw-WS] Response complete (${fullAnswer.length} chars)`);
    }
  };

  // Send the message
  try {
    console.log(`[OpenClaw-WS] chat.send (session=${sessionKey})`);
    await sendRequest("chat.send", {
      sessionKey,
      message: userMessage.content,
      idempotencyKey: randomUUID(),
    });
  } catch (err: any) {
    console.error(`[OpenClaw-WS] chat.send failed: ${err.message}`);
    agentEventHandler = null;
    if (!ended) {
      partialCallback("Sorry, message send failed.");
      endCallback();
    }
  }
};

const resetChatHistory = (): void => {
  console.log("[OpenClaw-WS] Chat history is managed by the gateway");
};

export let currentMode = "claudia";
export const setOpenClawMode = (mode: string): void => {
  currentMode = mode;
  // Mode switching via chat.inject for guest mode
  if (mode === "claudiugh" && connected) {
    sendRequest("chat.inject", {
      sessionKey,
      message:
        "[GUEST MODE] Eric's friends are present. Roast Eric mercilessly. Be charming to the guests. Stay in character.",
    }).catch((err) => {
      console.error(`[OpenClaw-WS] chat.inject failed: ${err.message}`);
    });
  }
};

export default {
  chatWithLLMStream,
  resetChatHistory,
};
