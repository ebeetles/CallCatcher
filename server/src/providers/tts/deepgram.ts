import type { TtsProvider } from "../types.ts";
import { config } from "../../config.ts";

/**
 * Deepgram Aura-2 TTS. Returns raw mulaw 8k (no container) so bytes go
 * straight to the phone leg with no transcoding. ~$0.030 per 1k chars.
 */
export class DeepgramTts implements TtsProvider {
  readonly id = "deepgram";

  voices() {
    return [
      { id: "aura-2-thalia-en", label: "Thalia — clear, confident (US female)" },
      { id: "aura-2-andromeda-en", label: "Andromeda — calm, expressive (US female)" },
      { id: "aura-2-helena-en", label: "Helena — warm, friendly (US female)" },
      { id: "aura-2-apollo-en", label: "Apollo — casual, comfortable (US male)" },
      { id: "aura-2-arcas-en", label: "Arcas — natural, smooth (US male)" },
      { id: "aura-2-orion-en", label: "Orion — approachable (US male)" },
    ];
  }

  async *synthesize(text: string, voiceId: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const params = new URLSearchParams({
      model: voiceId || "aura-2-thalia-en",
      encoding: "mulaw",
      sample_rate: "8000",
      container: "none",
    });
    const res = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Token ${config.deepgramKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`Deepgram TTS ${res.status}: ${body.slice(0, 200)}`);
    }
    const reader = (res.body as any).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) yield Buffer.from(value);
    }
  }
}
