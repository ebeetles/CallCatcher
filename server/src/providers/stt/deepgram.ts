import WebSocket from "ws";
import type { SttCallbacks, SttProvider, SttStream } from "../types.ts";
import { config } from "../../config.ts";

/**
 * Deepgram live streaming STT over WebSocket.
 * Nova-3, mulaw 8k in, endpointing for turn detection, VAD events for barge-in.
 */
export class DeepgramStt implements SttProvider {
  readonly id = "deepgram";

  async start(cb: SttCallbacks): Promise<SttStream> {
    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "mulaw",
      sample_rate: "8000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      vad_events: "true",
      filler_words: "false",
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${config.deepgramKey}` },
    });

    /** Finalized-but-not-yet-endpointed pieces of the current utterance. */
    let pending: string[] = [];
    let closed = false;
    let keepAlive: NodeJS.Timeout | undefined;

    const flushFinal = () => {
      const text = pending.join(" ").trim();
      pending = [];
      if (text) cb.onFinal(text);
    };

    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "Results") {
        const alt = msg.channel?.alternatives?.[0];
        const transcript: string = alt?.transcript ?? "";
        if (msg.is_final) {
          if (transcript.trim()) pending.push(transcript.trim());
          if (msg.speech_final) flushFinal();
        } else if (transcript.trim()) {
          cb.onPartial([...pending, transcript.trim()].join(" "));
        }
      } else if (msg.type === "UtteranceEnd") {
        // Fallback endpoint when speech_final never fired (e.g. trailing noise).
        flushFinal();
      } else if (msg.type === "SpeechStarted") {
        cb.onSpeechStarted();
      }
    });

    ws.on("error", (err) => {
      if (!closed) cb.onError(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => {
      if (keepAlive) clearInterval(keepAlive);
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);

    return {
      sendAudio(chunk: Buffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      },
      async close() {
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "CloseStream" }));
          } catch {
            // ignore
          }
        }
        ws.close();
      },
    };
  }
}
