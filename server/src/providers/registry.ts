import type { LlmProvider, SttProvider, TtsProvider } from "./types.ts";
import { DeepgramStt } from "./stt/deepgram.ts";
import { MockStt } from "./stt/mock.ts";
import { AnthropicLlm } from "./llm/anthropic.ts";
import { OpenAiLlm } from "./llm/openai.ts";
import { MockLlm } from "./llm/mock.ts";
import { DeepgramTts } from "./tts/deepgram.ts";
import { ElevenLabsTts } from "./tts/elevenlabs.ts";
import { AzureTts } from "./tts/azure.ts";
import { MockTts } from "./tts/mock.ts";
import { config, providerStatus } from "../config.ts";

const stt: Record<string, SttProvider> = {
  deepgram: new DeepgramStt(),
  mock: new MockStt(),
};

const llm: Record<string, LlmProvider> = {
  anthropic: new AnthropicLlm(),
  openai: new OpenAiLlm(),
  mock: new MockLlm(),
};

const tts: Record<string, TtsProvider> = {
  deepgram: new DeepgramTts(),
  elevenlabs: new ElevenLabsTts(),
  azure: new AzureTts(),
  mock: new MockTts(),
};

function usable(kind: "stt" | "llm" | "tts", id: string): boolean {
  if (config.mockProviders) return id === "mock";
  const s = providerStatus() as any;
  return !!s[kind]?.[id];
}

/** Resolve a provider, falling back to mock (with a log line) if its key is missing. */
export function getStt(id: string): SttProvider {
  if (stt[id] && usable("stt", id)) return stt[id];
  if (id !== "mock") console.warn(`[providers] STT '${id}' unavailable (missing key?) — using mock`);
  return stt.mock;
}

export function getLlm(id: string): LlmProvider {
  if (llm[id] && usable("llm", id)) return llm[id];
  if (id !== "mock") console.warn(`[providers] LLM '${id}' unavailable (missing key?) — using mock`);
  return llm.mock;
}

export function getTts(id: string): TtsProvider {
  if (tts[id] && usable("tts", id)) return tts[id];
  if (id !== "mock") console.warn(`[providers] TTS '${id}' unavailable (missing key?) — using mock`);
  return tts.mock;
}

export function listVoices(): Record<string, Array<{ id: string; label: string }>> {
  return {
    deepgram: tts.deepgram.voices(),
    elevenlabs: tts.elevenlabs.voices(),
    azure: tts.azure.voices(),
    mock: tts.mock.voices(),
  };
}
