# OpenClaw Integration Architecture

> How WhisPlay connects to an OpenClaw gateway for voice-first AI chat.

## Overview

WhisPlay is a voice-first AI chatbot designed for Raspberry Pi hardware (speaker, microphone, display). It has a pluggable architecture for ASR, LLM, and TTS providers. This document describes the **OpenClaw integration** — how WhisPlay uses an OpenClaw gateway as its LLM backend, turning the Pi into a physical voice interface for an OpenClaw agent.

The system has three layers:

```mermaid
graph TB
    subgraph device["WhisPlay Device (Raspberry Pi)"]
        mic["🎤 Mic (ALSA)"]
        asr["ASR Plugin<br/>(e.g. OpenAI Whisper)"]
        llm_plugin["LLM Plugin<br/>(openclaw-ws / openclaw)"]
        tts["TTS Plugin<br/>(e.g. OpenAI TTS)"]
        speaker["🔊 Speaker (ALSA)"]
        display["WhisPlay HAT<br/>(display / LED)"]
        stream["StreamResponser<br/>(sentence split + pipeline)"]

        mic --> asr
        asr --> llm_plugin
        llm_plugin --> stream
        stream --> tts
        tts --> speaker
        stream --> display
    end

    subgraph gateway["OpenClaw Gateway (any host)"]
        ws_server["Gateway WebSocket Server<br/>• Device auth (Ed25519 v3)<br/>• Session management<br/>• Agent routing"]
        agent["Agent Runtime<br/>• Personality / system prompt<br/>• Conversation history<br/>• Memory &amp; tools"]
        llm_provider["LLM Provider<br/>(Claude, GPT, Gemini, etc.)"]

        ws_server --> agent
        agent --> llm_provider
    end

    llm_plugin -- "WebSocket (persistent)<br/>or HTTP/SSE" --> ws_server

    subgraph cloud["Cloud APIs"]
        openai_asr["OpenAI Whisper API"]
        openai_tts["OpenAI TTS API"]
        llm_cloud["Anthropic / OpenAI / etc."]
    end

    asr --> openai_asr
    tts --> openai_tts
    llm_provider --> llm_cloud

    style device fill:#1a1a2e,stroke:#16213e,color:#e0e0e0
    style gateway fill:#0f3460,stroke:#16213e,color:#e0e0e0
    style cloud fill:#533483,stroke:#16213e,color:#e0e0e0
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

```mermaid
sequenceDiagram
    participant W as WhisPlay
    participant G as Gateway

    W->>G: WebSocket open
    G->>W: event: connect.challenge {nonce}
    W->>G: req: connect {client, auth, device}<br/>(Ed25519 signature over nonce+token)
    G->>W: res: connect OK

    Note over W,G: Connection established — ready for chat

    W->>G: req: chat.send {sessionKey, message}
    G->>W: event: agent {stream:"assistant", delta:"Hello..."}
    G->>W: event: agent {stream:"assistant", delta:" world"}
    G->>W: event: agent {stream:"lifecycle", event:"end"}
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

```mermaid
sequenceDiagram
    participant U as User (voice)
    participant W as WhisPlay
    participant G as Gateway

    U->>W: Speaks into mic
    W->>W: ASR → text
    W->>G: POST /whisplay-im/inbox {message}
    G->>W: 200 OK (acknowledged)
    W->>W: ChatFlow → sleep (done sending)

    Note over G: Gateway processes with agent...<br/>agent thinks, uses tools, generates reply

    G->>W: POST /whisplay-im/send {reply, emoji}
    W->>W: ChatFlow → external_answer
    W->>W: TTS → speaker 🔊
    W->>W: ChatFlow → sleep
```

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

```mermaid
stateDiagram-v2
    [*] --> sleep

    sleep --> listening: Button press
    listening --> asr: Button release<br/>(recording stops)
    asr --> answer: Text recognized
    asr --> wake_listening: No speech<br/>(wake session active)
    asr --> sleep: No speech

    answer --> sleep: Response complete
    answer --> listening: Button press<br/>(interrupt)
    answer --> wake_listening: Response complete<br/>(wake session active)
    answer --> image: Response has image

    image --> listening: Button press
    image --> sleep: Timeout

    sleep --> wake_listening: Wake word detected
    wake_listening --> asr: Voice detected<br/>(recording stops)
    wake_listening --> sleep: Idle timeout

    sleep --> camera: Double-click
    camera --> sleep: Exit camera mode

    note right of answer
        1. chat.send to gateway
        2. Stream text deltas
        3. Split into sentences
        4. Pipeline TTS generation
        5. Play audio sequentially
    end note
```

**Detailed flow (button-press mode):**

1. **Button press** → ChatFlow: `sleep → listening`, sox records from ALSA mic
2. **Button release** → Recording stops, ChatFlow: `listening → asr`
3. **ASR** → Audio sent to speech-to-text provider, returns transcribed text
4. **Send to OpenClaw** → `chat.send({sessionKey, message})` over WebSocket
5. **Streaming response** → Gateway pushes text deltas, StreamResponser splits into sentences, each immediately queued for TTS
6. **TTS + playback pipeline** → Sentences converted to audio and played sequentially; TTS for sentence N+1 begins while N is playing (pipelining)
7. **Complete** → `lifecycle:end` event, drain audio queue, ChatFlow: `answer → sleep`

**Pipelining** is key to low latency — TTS generation overlaps with both LLM streaming and audio playback:

```mermaid
gantt
    title Response Pipeline (time →)
    dateFormat X
    axisFormat %s

    section LLM Stream
    Sentence 1 arrives     :a1, 0, 1
    Sentence 2 arrives     :a2, 1, 2
    Sentence 3 arrives     :a3, 2, 3

    section TTS Generation
    TTS sentence 1         :b1, 0, 2
    TTS sentence 2         :b2, 1, 3
    TTS sentence 3         :b3, 2, 4

    section Audio Playback
    Play sentence 1        :c1, 2, 5
    Play sentence 2        :c2, 5, 8
    Play sentence 3        :c3, 8, 11
```

## Mode Switching & Agent Label

WhisPlay supports runtime personality/agent switching without restart. The current mode is tracked in `ChatFlow.currentMode` and propagated to both the OpenClaw transport (via `setOpenClawMode()`) and the TTS voice settings.

Mode can be triggered via:
- The display hardware's guest-mode toggle (quad-tap)
- The IM bridge `/whisplay-im/mode` endpoint
- The IM bridge `/whisplay-im/status` endpoint (via `mode_label` field)

When switching to a non-default mode, the WS transport injects a system prompt via `chat.inject` to alter the agent's behavior for the session.

### Persistent Status Bar

The display maintains two persistent fields that survive status transitions (listening → answering → idle etc.):

| Field | Purpose | Set by |
|---|---|---|
| `mode_label` | Agent name or mode label shown in the status bar (e.g. "claudia", "guest mode") | Startup (from `OPENCLAW_AGENT_ID` or `WHISPLAY_MODE_LABEL` env), mode switch, or gateway push via `/whisplay-im/status` |
| `gateway_connected` | Whether the LLM gateway WebSocket is active (for visual connection indicator) | `openclaw-ws.ts` on connect/disconnect |

These fields are forwarded to both the hardware display (Python HAT renderer) and the web display (WebSocket to browser).

**Multi-agent use case:** When switching between different agents (e.g. swapping `OPENCLAW_AGENT_ID` at runtime or routing to different gateway sessions), `mode_label` gives the user a persistent visual indicator of which agent they're currently talking to — useful for setups where a single WhisPlay device can be pointed at multiple AI personas.

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

# Device identity file (default: .whisplay-device.json in project root)
# OPENCLAW_DEVICE_IDENTITY_PATH=.whisplay-device.json

# Response timeout in ms (default: 120000 = 2 min)
# OPENCLAW_RESPONSE_TIMEOUT_MS=120000

# Display label override (defaults to OPENCLAW_AGENT_ID if not set)
# WHISPLAY_MODE_LABEL=my-agent

# ASR/TTS (independent of LLM transport)
ASR_SERVER=openai
TTS_SERVER=openai
OPENAI_API_KEY=sk-...

# Hardware volume (amixer raw value, 0-127)
INITIAL_VOLUME_LEVEL=100
```

## Network Topology

```mermaid
graph LR
    pi["WhisPlay Device<br/>(Raspberry Pi)"]
    gw["OpenClaw Gateway<br/>(any host)"]
    cloud_asr["ASR API<br/>(e.g. OpenAI Whisper)"]
    cloud_tts["TTS API<br/>(e.g. OpenAI TTS)"]
    cloud_llm["LLM API<br/>(Anthropic, OpenAI, etc.)"]

    pi -- "WebSocket / HTTP<br/>(LAN or VPN)" --> gw
    pi -- "HTTPS" --> cloud_asr
    pi -- "HTTPS" --> cloud_tts
    gw -- "HTTPS" --> cloud_llm

    style pi fill:#1a1a2e,stroke:#e0e0e0,color:#e0e0e0
    style gw fill:#0f3460,stroke:#e0e0e0,color:#e0e0e0
    style cloud_asr fill:#533483,stroke:#e0e0e0,color:#e0e0e0
    style cloud_tts fill:#533483,stroke:#e0e0e0,color:#e0e0e0
    style cloud_llm fill:#533483,stroke:#e0e0e0,color:#e0e0e0
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
