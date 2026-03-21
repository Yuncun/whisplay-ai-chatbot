/**
 * OpenClaw LLM Plugin
 *
 * Connects directly to an OpenClaw gateway via its OpenAI-compatible
 * /v1/chat/completions endpoint with SSE streaming. The gateway handles
 * agent routing, personality, memory, and conversation history.
 *
 * .env config:
 *   OPENCLAW_BASE_URL=http://100.104.104.9:18789
 *   OPENCLAW_TOKEN=your-token
 *   OPENCLAW_AGENT_ID=claudia
 */

import { Message } from "../../type";
import { ChatWithLLMStreamFunction } from "../interface";
import dotEnv from "dotenv";

dotEnv.config();

const baseUrl = process.env.OPENCLAW_BASE_URL || "http://localhost:18789";
const token = process.env.OPENCLAW_TOKEN || "";
const agentId = process.env.OPENCLAW_AGENT_ID || "claudia";

let currentMode = "claudia";
export const setOpenClawMode = (mode: string): void => {
  currentMode = mode;
};

const chatWithLLMStream: ChatWithLLMStreamFunction = async (
  inputMessages: Message[] = [],
  partialCallback: (partialAnswer: string) => void,
  endCallback: () => void,
  _partialThinkingCallback?: (partialThinking: string) => void,
  _invokeFunctionCallback?: (functionName: string, result?: string) => void,
): Promise<void> => {
  const url = `${baseUrl}/v1/chat/completions`;

  // Build messages array from input (OpenClaw manages its own history)
  const messages = inputMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const user = currentMode === "claudiugh" ? "whisplay-guest" : "whisplay";
  const body = JSON.stringify({
    model: "openclaw",
    stream: true,
    messages,
    user,
  });

  console.log(`[OpenClaw] POST ${url} (stream=true, agent=${agentId})`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "x-openclaw-agent-id": agentId,
      },
      body,
    });
  } catch (err: any) {
    console.error(`[OpenClaw] Connection failed: ${err.message}`);
    partialCallback("Sorry, I can't reach OpenClaw right now.");
    endCallback();
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[OpenClaw] HTTP ${response.status}: ${text.slice(0, 300)}`);
    partialCallback(`OpenClaw error (${response.status}).`);
    endCallback();
    return;
  }

  if (!response.body) {
    console.error("[OpenClaw] No response body");
    partialCallback("No response from OpenClaw.");
    endCallback();
    return;
  }

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let fullAnswer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // Process complete lines
      while (buf.includes("\n")) {
        const nlIndex = buf.indexOf("\n");
        const line = buf.slice(0, nlIndex).trim();
        buf = buf.slice(nlIndex + 1);

        if (!line) continue;
        if (!line.startsWith("data:")) continue;

        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") {
          endCallback();
          console.log(`[OpenClaw] Response complete (${fullAnswer.length} chars)`);
          return;
        }

        try {
          const data = JSON.parse(dataStr);
          const choices = data.choices || [];
          if (choices.length > 0) {
            const content = choices[0]?.delta?.content || "";
            if (content) {
              fullAnswer += content;
              partialCallback(content);
            }
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }
  } catch (err: any) {
    console.error(`[OpenClaw] Stream error: ${err.message}`);
  }

  endCallback();
  console.log(`[OpenClaw] Response complete (${fullAnswer.length} chars)`);
};

const resetChatHistory = (): void => {
  // OpenClaw manages conversation history on the gateway side — nothing to reset here
  console.log("[OpenClaw] Chat history is managed by the gateway");
};

export default {
  chatWithLLMStream,
  resetChatHistory,
};
