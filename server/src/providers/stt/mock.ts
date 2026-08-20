import type { SttCallbacks, SttOptions, SttProvider, SttStream } from "../types.ts";

/**
 * Keyless STT stand-in. It cannot understand audio; instead, after it hears
 * ~1s of incoming audio followed by ~1s of silence (no packets with energy),
 * it emits the next line from a canned script. Good enough to demo the full
 * audio loop without a Deepgram key. For deterministic input, use the
 * transport's text-injection path (web dialer text mode / tests).
 */
const SCRIPT = [
  "Hi, what are your hours today?",
  "Great. I'd like to book an appointment please.",
  "My name is Jamie Rivera, my number is five five five, zero one zero zero. Any time Friday afternoon works.",
  "That's everything, thank you. Goodbye!",
];

export class MockStt implements SttProvider {
  readonly id = "mock";

  async start(cb: SttCallbacks, _opts: SttOptions = {}): Promise<SttStream> {
    let bytesSinceQuiet = 0;
    let scriptIndex = 0;
    let speaking = false;
    let quietTimer: NodeJS.Timeout | undefined;
    let closed = false;

    const endUtterance = () => {
      if (closed || !speaking) return;
      speaking = false;
      bytesSinceQuiet = 0;
      const line = SCRIPT[Math.min(scriptIndex, SCRIPT.length - 1)];
      scriptIndex++;
      cb.onFinal(line);
    };

    return {
      sendAudio(chunk: Buffer) {
        if (closed) return;
        // Treat any audio that isn't pure mulaw silence as speech energy.
        let energy = 0;
        for (let i = 0; i < chunk.length; i += 16) {
          const b = chunk[i];
          if (b !== 0xff && b !== 0x7f) energy++;
        }
        if (energy > 2) {
          bytesSinceQuiet += chunk.length;
          if (!speaking && bytesSinceQuiet > 4000) {
            speaking = true;
            cb.onSpeechStarted();
            cb.onPartial("...");
          }
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(endUtterance, 900);
        }
      },
      async close() {
        closed = true;
        if (quietTimer) clearTimeout(quietTimer);
      },
    };
  }
}
