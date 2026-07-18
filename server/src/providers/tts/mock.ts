import type { TtsProvider } from "../types.ts";
import { mulawSilence, mulawTone } from "../../audio/mulaw.ts";

/**
 * Keyless TTS stand-in: renders each sentence as a soft melodic tone whose
 * length tracks the text length, so web-dialer demos are audibly "alive"
 * and tests can assert audio actually flowed.
 */
export class MockTts implements TtsProvider {
  readonly id = "mock";

  voices() {
    return [
      { id: "tone-a", label: "Demo tone A (440 Hz)" },
      { id: "tone-b", label: "Demo tone B (523 Hz)" },
    ];
  }

  async *synthesize(text: string, voiceId: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const words = Math.max(1, text.trim().split(/\s+/).length);
    const durationMs = Math.min(4000, 220 + words * 110);
    const freq = voiceId === "tone-b" ? 523 : 440;
    const audio = Buffer.concat([mulawTone(durationMs, freq), mulawSilence(120)]);
    // Yield in 20ms frames like a real streaming TTS would.
    for (let off = 0; off < audio.length; off += 160) {
      if (signal.aborted) return;
      yield audio.subarray(off, Math.min(off + 160, audio.length));
    }
  }
}
