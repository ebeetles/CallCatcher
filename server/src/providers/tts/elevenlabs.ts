import type { TtsProvider } from "../types.ts";
import { config } from "../../config.ts";

/**
 * ElevenLabs streaming TTS with ulaw_8000 output (telephony-native).
 * Flash v2.5 is the low-latency model (~75ms model latency).
 * Premium quality but ~3-5x the cost of Aura-2.
 */
export class ElevenLabsTts implements TtsProvider {
  readonly id = "elevenlabs";

  voices() {
    return [
      { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — calm, professional (female)" },
      { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah — soft, warm (female)" },
      { id: "FGY2WhTYpPnrIDTdsKH5", label: "Laura — upbeat (female)" },
      { id: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam — articulate (male)" },
      { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel — deep, authoritative (male)" },
    ];
  }

  async *synthesize(text: string, voiceId: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}/stream?output_format=ulaw_8000`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "xi-api-key": config.elevenlabsKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS ${res.status}: ${body.slice(0, 200)}`);
    }
    const reader = (res.body as any).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) yield Buffer.from(value);
    }
  }
}
