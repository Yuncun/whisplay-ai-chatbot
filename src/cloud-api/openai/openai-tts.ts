import mp3Duration from "mp3-duration";
import { openai } from "./openai"; // Assuming openai is exported from openai.ts
import dotenv from "dotenv";
import { TTSResult } from "../../type";

dotenv.config();

const openAiVoiceModel = process.env.OPENAI_VOICE_MODEL || "tts-1"; // Default to tts-1
const openAiVoiceType = process.env.OPENAI_VOICE_TYPE || "nova"; // Optional: alloy, echo, fable, onyx, nova, shimmer

let currentTTSInstructions = "";
let currentTTSVoiceOverride = "";
let currentTTSSpeedOverride = 0; // 0 = use default (1.0)
export const setTTSInstructions = (instructions: string, voiceOverride?: string, speedOverride?: number): void => {
  currentTTSInstructions = instructions;
  currentTTSVoiceOverride = voiceOverride || "";
  currentTTSSpeedOverride = speedOverride || 0;
};

const openaiTTS = async (
  text: string
): Promise<TTSResult> => {
  if (!openai) {
    console.error("OpenAI API key is not set.");
    return { duration: 0 };
  }
  // Use gpt-4o-mini-tts when instructions are set (supports voice instructions)
  const model = currentTTSInstructions ? "gpt-4o-mini-tts" : openAiVoiceModel;
  const params: Record<string, any> = {
    model,
    voice: currentTTSVoiceOverride || openAiVoiceType,
    input: text,
  };
  if (currentTTSInstructions) {
    params.instructions = currentTTSInstructions;
  }
  if (currentTTSSpeedOverride > 0) {
    params.speed = currentTTSSpeedOverride;
  }
  const mp3 = await openai.audio.speech.create(params as any).catch((error) => {
    console.log("OpenAI TTS failed:", error);
    return null;
  });
  if (!mp3) {
    return { duration: 0 };
  }
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const duration = await mp3Duration(buffer);
  return { buffer, duration: duration * 1000 };
};

export default openaiTTS;
