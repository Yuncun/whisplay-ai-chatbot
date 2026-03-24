# OpenClaw Integration Architecture

> How WhisPlay connects to an OpenClaw gateway for voice-first AI chat.

## Overview

WhisPlay is a voice-first AI chatbot designed for Raspberry Pi hardware (speaker, microphone, display). It has a pluggable architecture for ASR, LLM, and TTS providers. This document describes the **OpenClaw integration** — how WhisPlay uses an OpenClaw gateway as its LLM backend, turning the Pi into a physical voice interface for an OpenClaw agent.

The system has three layers:

```
┌─────────────────────────────────────────────────────────┐
│  WhisPlay Device  (Raspberry Pi)                        │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐  │
│  │   Mic   │→ │  ASR      │→ │  LLM     │→ │  TTS   │→ │ Speaker
│  │ (ALSA)  │  │ (OpenAI)  │  │(OpenClaw)│  │(OpenAI)│  │
│  └─────────┘  └───────────┘  └────┬─────┘  └────────┘  │
│       ┌────────────────┐          │                     │
│       │ WhisPlay HAT   │          │                     │
│       │ (display/LED)  │          │                     │
│       └────────────────┘          │                     │
└───────────────────────────────────┼─────────────────────┘
                                    │ WebSocket (persistent)
                                    │ or HTTP/SSE (stateless)
┌───────────────────────────────────┼─────────────────────┐
│  OpenClaw Gateway  (any host)                           │
│                                   │                     │
│  ┌────────────────────────────────▼──────────────────┐  │
│  │  Gateway WebSocket Server                         │  │
│  │  • Device auth (Ed25519 v3)                       │  │
│  │  • Session management                             │  │
│  │  • Agent routing                                  │  │
│  └───────────────────────────────────────────────────┘  │
│                         │                               │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │  Agent Runtime                                    │  │
│  │  • Personality / system prompt                    │  │
│  │  • Conversation history                           │  │
│  │  • Memory                                         │  │
│  │  • Tool access (web search, file ops, etc.)       │  │
│  └───────────────────────────────────────────────────┘  │
│                         │                               │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │  LLM Provider  (Claude, GPT, Gemini, etc.)        │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## What Runs Where

### On the WhisPlay Device (Raspberry Pi)

| Component | Responsibility |
|---|---|
| **ChatFlow state machine** (`src/core/ChatFlow.ts`, `src/core/chat-flow/`) | Orchestrates the full conversation loop: sleep → listen → ASR → answer → sleep |
| **Audio I/O** (`src/device/audio.ts`) | ALSA recording via `sox`, playback via `sox` (WAV) or `mpg123` (MP3) |
| **ASR plugin** (e.g. `src/cloud-api/openai/openai-asr.ts`) | Sends recorded audio to a cloud STT service, returns text |
| **TTS plugin** (e.g. `src/cloud-api/openai/openai-tts.ts`) | Sends response text to a cloud TTS service, returns audio |
| **StreamResponser** (`src/core/StreamResponsor.ts`) | Receives streaming LLM text, splits into sentences, pipelines TTS generation with audio playback |
| **LLM plugin** (`openclaw-ws` or `openclaw`) | Sends user text to OpenClaw gateway, receives streamed agent response |
| **Display driver** (`src/device/display.ts`) | Drives the WhisPlay HAT LCD/LED (emoji, status text, scroll sync) |
| **Volume control** (`src/utils/volume.ts`) | amixer wrapper with logarithmic volume curve |
| **IM Bridge server** (`src/device/im-bridge.ts`) | Local HTTP server for receiving pushed replies from the gateway (IM mode) |
| **Web Audio Bridge** (`src/device/web-audio-bridge.ts`) | Optional: routes mic/speaker through a browser client instead of ALSA hardware |
| **Wake word listener** (`src/device/wakeword.ts`) | Optional: hands-free activation |
| **Device identity** (`.whisplay-device.json`) | Ed25519 keypair + device ID for gateway pairing |

### On the OpenClaw Gateway

| Component | Responsibility |
|---|---|
| **Gateway WebSocket server** | Accepts persistent WS connections, handles auth and session routing |
| **Device pairing** (`extensions/device-pair/`) | QR code / bootstrap token flow for pairing new devices |
| **Agent runtime** | Manages agent personality, conversation history, memory, and tool execution |
| **LLM provider routing** | Forwards agent prompts to configured LLM (Claude, GPT, etc.) |
| **Session management** | Maintains per-agent sessions (`agent:<agentId>:main`) with full history |

### Cloud Services (external)

| Service | Used By | Purpose |
|---|---|---|
| **OpenAI Whisper API** | WhisPlay (ASR plugin) | Speech-to-text |
| **OpenAI TTS API** | WhisPlay (TTS plugin) | Text-to-speech |
| **Anthropic Claude / OpenAI GPT / etc.** | OpenClaw Gateway | LLM inference (via gateway's configured provider) |

## LLM Transport Modes

WhisPlay supports three modes for communicating with OpenClaw. The mode is selected by `LLM_SERVER` in `.env`.

### `openclaw-ws` — WebSocket (recommended)

**File:** `src/cloud-api/openclaw/openclaw-ws.ts`

A persistent bidirectional WebSocket connection to the gateway. This is the preferred mode because it supports real-time streaming, gateway-pushed events, and automatic reconnection.

**Connection lifecycle:**

```
WhisPlay                                     Gateway
   │                                            │
   │──── WebSocket open ────────────────────────▶│
   │                                            │
   │◀─── event: connect.challenge {nonce} ──────│
   │                                            │
   │──── req: connect {client, auth, device} ──▶│
   │     (Ed25519 signature over nonce+token)   │
   │                                            │
   │◀─── res: connect OK ──────────────────────│
   │                                            │
   │──── req: chat.send {sessionKey, message} ─▶│
   │                                            │
   │◀─── event: agent {stream:"assistant",     │
   │            data:{delta:"Hello..."}} ───────│
   │◀─── event: agent {stream:"assistant",     │
   │            data:{delta:" world"}} ─────────│
   │◀─── event: agent {stream:"lifecycle",     │
   │            data:{event:"end"}} ────────────│
   │                                            │
```

**Frame protocol:**

All frames are JSON objects with a `type` field:

| Type | Direction | Purpose |
|---|---|---|
| `req` | Client → Gateway | Request (method + params), includes `id` for correlation |
| `res` | Gateway → Client | Response to a request, matched by `id`. Has `ok` boolean |
| `event` | Gateway → Client | Push event (agent streaming, tick/health keepalives) |

**Methods used by WhisPlay:**

| Method | Purpose |
|---|---|
| `connect` | Authenticate and establish session (protocol v3, Ed25519 device auth) |
| `chat.send` | Send a user message to an agent session |
| `chat.inject` | Inject a system message (e.g. personality mode switch) |

The gateway also supports `chat.history` and `chat.abort`, but the WhisPlay client does not currently use them.

**Agent event streams:**

When the agent is responding, the gateway pushes `event` frames with `event: "agent"`:

- `stream: "assistant"` + `data.delta` — incremental text chunks of the response
- `stream: "lifecycle"` + `data.event: "end"` — signals response complete

**Reconnection:** Exponential backoff starting at 1s, capped at 30s. Auth errors (close code 1008) halt reconnection to avoid loops.

### `openclaw` — HTTP/SSE (stateless fallback)

**File:** `src/cloud-api/openclaw/openclaw-llm.ts`

A stateless HTTP client that hits the gateway's OpenAI-compatible `/v1/chat/completions` endpoint with `stream: true`. Each request is independent — no persistent connection.

**Request flow:**

```
POST /v1/chat/completions
Authorization: Bearer <OPENCLAW_TOKEN>
x-openclaw-agent-id: <agent-id>
Content-Type: application/json

{
  "model": "openclaw",
  "stream": true,
  "messages": [{"role": "user", "content": "Hello"}],
  "user": "whisplay"
}
```

**Response:** Standard SSE stream of `data: {...}` lines with OpenAI-format chunks, ending with `data: [DONE]`.

This mode is simpler but lacks push events, presence, and gateway-initiated messages.

### `whisplay-im` — IM Bridge (bidirectional push)

**Files:** `src/cloud-api/whisplay-im/whisplay-im.ts` + `src/device/im-bridge.ts`

> **Note:** This mode is fundamentally different from the other two. It changes the entire ChatFlow behavior, not just the transport layer.

In the WebSocket and HTTP modes, `chatWithLLMStream` handles the full request-response cycle: send user text, receive streamed agent text, feed it to the TTS pipeline. The ChatFlow `answer` state manages everything in one place.

In IM bridge mode, the flow is split in two:

1. **Outbound** (user speaks): `chatWithLLMStream` fires a POST to the OpenClaw gateway's IM inbox and **returns immediately** — no streaming, no response text. The ChatFlow `answer` state transitions back to `sleep` after the POST confirms delivery.

2. **Inbound** (agent replies): The gateway pushes the complete response to WhisPlay's local HTTP server (`WhisplayIMBridgeServer` on port 18888). This triggers a `reply` event on the bridge, which causes ChatFlow to transition into a separate `external_answer` state that handles TTS playback.

This means there's an asynchronous gap between the user's utterance and the agent's spoken response. The gateway controls when and how to deliver the reply.

**IM Bridge endpoints** (`WhisplayIMBridgeServer`):

| Endpoint | Method | Purpose |
|---|---|---|
| `/whisplay-im/inbox` | POST | Receive user messages (from gateway or direct) |
| `/whisplay-im/poll` | GET | Long-poll for queued messages (alternative to push) |
| `/whisplay-im/send` | POST | Receive agent replies (text + optional image + emoji) |
| `/whisplay-im/status` | POST | Receive agent status updates (thinking, tool_calling, etc.) |
| `/whisplay-im/mode` | POST | Switch personality mode at runtime |

The `status` endpoint drives the display — when the gateway reports `thinking` or `tool_calling`, the WhisPlay display updates accordingly, giving the user visual feedback during the async gap.

## Device Authentication (v3 Protocol)

WhisPlay authenticates to the gateway using **Ed25519 device signatures**, not just a bearer token. This is the same protocol used by the OpenClaw mobile apps.

**Setup:** On first pairing, a bootstrap token is exchanged (via QR code or manual entry). The device generates an Ed25519 keypair and stores it in `.whisplay-device.json`:

```json
{
  "deviceId": "<sha256 hex>",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n..."
}
```

**Auth flow (each connection):**

1. Gateway sends `connect.challenge` with a random `nonce`
2. WhisPlay constructs a pipe-delimited payload string:
   ```
   v3|<deviceId>|<clientId>|<clientMode>|<role>|<scopes>|<timestampMs>|<token>|<nonce>|<platform>|<deviceFamily>
   ```
3. Signs the payload with the Ed25519 private key
4. Sends the `connect` frame with the signature, raw public key (base64url), and metadata
5. Gateway verifies signature against the paired device's known public key

## Conversation Flow

Here's how a complete voice interaction works end-to-end (using `openclaw-ws` mode):

```
1. USER PRESSES BUTTON
   └→ ChatFlow transitions: sleep → listening
   └→ Display: 🟢 "Listening..." + LED green
   └→ sox starts recording from ALSA mic

2. USER RELEASES BUTTON
   └→ Recording stops, saved as .wav/.mp3
   └→ ChatFlow transitions: listening → asr

3. SPEECH-TO-TEXT
   └→ Audio file sent to ASR provider (e.g. OpenAI Whisper)
   └→ Returns transcribed text
   └→ Display shows recognized text
   └→ ChatFlow transitions: asr → answer

4. SEND TO OPENCLAW
   └→ openclaw-ws: chat.send({sessionKey, message})
   └→ Gateway routes to agent, agent starts processing

5. STREAMING RESPONSE
   └→ Gateway pushes agent events with text deltas
   └→ StreamResponser splits text into sentences
   └→ Each sentence immediately queued for TTS
   └→ First sentence TTS starts while later text still streaming

6. TTS + PLAYBACK PIPELINE
   └→ Sentence → TTS provider (e.g. OpenAI TTS) → audio buffer
   └→ Audio played via sox/mpg123 through ALSA speaker
   └→ Display scrolls text in sync with audio playback
   └→ Next sentence TTS may already be cached (pipelined)

7. RESPONSE COMPLETE
   └→ Gateway sends lifecycle:end event
   └→ StreamResponser drains remaining audio queue
   └→ ChatFlow transitions: answer → sleep
   └→ Display: 😴 idle
```

**Pipelining:** Steps 5 and 6 overlap — TTS generation for sentence N+1 begins while sentence N is still playing. This significantly reduces perceived latency.

## Mode Switching

WhisPlay supports runtime personality switching without restart. The current mode is tracked in `ChatFlow.currentMode` and propagated to both the OpenClaw transport (via `setOpenClawMode()`) and the TTS voice settings.

Mode can be triggered via the IM bridge `/whisplay-im/mode` endpoint or from the display hardware's guest-mode toggle.

When switching to a guest mode, the WS transport injects a system prompt via `chat.inject` to alter the agent's behavior for the session.

## Configuration (.env)

Key environment variables for the OpenClaw integration:

```bash
# Transport mode: "openclaw-ws" (WebSocket), "openclaw" (HTTP/SSE), or "whisplay-im"
LLM_SERVER=openclaw-ws

# Gateway connection
OPENCLAW_BASE_URL=http://<gateway-host>:<port>
OPENCLAW_TOKEN=<your-auth-token>

# Agent to connect to
OPENCLAW_AGENT_ID=<agent-name>

# ASR/TTS (independent of LLM transport)
ASR_SERVER=openai
TTS_SERVER=openai
OPENAI_API_KEY=sk-...

# Hardware volume (amixer raw value, 0-127)
INITIAL_VOLUME_LEVEL=100
```

## Network Topology

The Pi and gateway communicate over the local network or a VPN (e.g. Tailscale):

```
WhisPlay Device (Pi)
    │
    │  WebSocket (ws://<gateway>:<port>)
    │  or HTTP  (http://<gateway>:<port>)
    ▼
OpenClaw Gateway (any host)
    │
    │  HTTPS (provider APIs)
    ▼
Cloud (api.openai.com, api.anthropic.com, etc.)
```

The Pi handles ASR and TTS directly with cloud providers (no gateway proxy), but all LLM/agent traffic goes through the gateway. This means the Pi needs:
- Network access to the OpenClaw gateway (LAN or VPN)
- Network access to the ASR/TTS provider APIs

## Web Audio Bridge (Optional)

When `WEB_AUDIO_ENABLED=true` and a browser client is connected to the WhisPlay web UI, the audio pipeline can optionally route through the browser instead of ALSA hardware:

- **Recording:** Browser MediaRecorder → WebSocket binary frames (type `0x01`) → server assembles audio file (with ffmpeg conversion from webm if needed)
- **Playback:** Server sends base64 audio via JSON WebSocket message → browser Audio API

Binary frame types (browser → server):
- `0x01` — audio chunk (MediaRecorder data)
- `0x02` — live camera JPEG frame
- `0x03` — camera capture JPEG (single high-quality photo)

This is useful for testing without physical hardware or for using a phone/tablet as the audio device.

## Known Issues

The following issues exist in the current `openclaw-ws.ts` implementation:

### 1. Double exponential backoff on reconnect

`scheduleReconnect()` doubles `reconnectDelay` immediately after scheduling the timer. When the timer fires and `doConnect()` fails, the `.catch()` doubles it again. The subsequent `close` event then calls `scheduleReconnect()` a second time. The net effect is that the delay increases ~4× per failed attempt instead of the intended 2×, and there's a risk of scheduling duplicate reconnect timers.

**Impact:** After a few failures, the reconnect delay jumps to 30s (the cap) much faster than expected.

### 2. No response timeout

If `chat.send` succeeds but the agent never completes (gateway crash, runaway tool loop, network drop after send), no `lifecycle:end` event arrives. The `agentEventHandler` stays set, `endCallback` is never called, and the ChatFlow remains stuck in the `answer` state. The user must press the physical button to escape.

**Mitigation:** ChatFlow's button handler transitions back to `listening` on press, which sidesteps the hang at the UI level. But the orphaned handler and callbacks are never cleaned up.

### 3. Singleton `agentEventHandler` with no stale cleanup

`agentEventHandler` is a module-level singleton. If a previous response was abandoned (button press mid-response, gateway drop), the old handler is silently overwritten by the next `chatWithLLMStream` call. The previous turn's `endCallback` is never invoked, which means the `StreamResponser.getPlayEndPromise()` from that turn hangs forever.

**Mitigation:** ChatFlow increments `answerId` on each new listen and guards callbacks with `currentAnswerId === ctx.answerId`, so stale callbacks become no-ops at the UI level. `StreamResponser.stop()` is also called on interruption. But the WS layer itself doesn't participate in this cleanup.

### 4. Hardcoded device identity path

The device identity file path is hardcoded to `/home/pi/whisplay-ai-chatbot/.whisplay-device.json`. This should be relative to the project root or configurable via an environment variable (e.g. `OPENCLAW_DEVICE_IDENTITY_PATH`).

## File Reference

| Path | Layer | Purpose |
|---|---|---|
| `src/cloud-api/openclaw/openclaw-ws.ts` | LLM plugin | WebSocket transport to gateway |
| `src/cloud-api/openclaw/openclaw-llm.ts` | LLM plugin | HTTP/SSE transport to gateway |
| `src/cloud-api/whisplay-im/whisplay-im.ts` | LLM plugin | IM bridge outbound (send to gateway) |
| `src/device/im-bridge.ts` | Device | IM bridge inbound server (receive from gateway) |
| `src/core/ChatFlow.ts` | Core | Main conversation orchestrator |
| `src/core/chat-flow/states.ts` | Core | State machine handlers (sleep, listen, ASR, answer, etc.) |
| `src/core/StreamResponsor.ts` | Core | Streaming text → sentence splitting → TTS pipeline |
| `src/device/audio.ts` | Device | ALSA recording/playback |
| `src/device/display.ts` | Device | WhisPlay HAT display driver |
| `src/device/web-audio-bridge.ts` | Device | Browser-based audio I/O bridge |
| `src/utils/volume.ts` | Utility | Logarithmic volume control |
| `src/cloud-api/server.ts` | Config | Plugin activation for ASR/LLM/TTS |
| `src/cloud-api/llm.ts` | Config | LLM plugin loader |
| `src/plugin/builtin/llm.ts` | Plugin | LLM plugin registry (all providers) |
| `.whisplay-device.json` | Config | Ed25519 device identity for gateway auth |
| `.env` | Config | All runtime configuration |
