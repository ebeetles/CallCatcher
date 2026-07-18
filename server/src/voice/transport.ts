import type WebSocket from "ws";

/**
 * Wraps a WebSocket speaking the Twilio Media Streams protocol.
 * The browser test dialer speaks the exact same protocol, plus two
 * extensions that are only used when the peer marks itself as web:
 *   inbound  {event:"text-input", text}          — typed instead of spoken
 *   outbound {event:"transcript"|"status", ...}  — live captions for the UI
 */

export interface StartMeta {
  streamSid: string;
  callSid?: string;
  customParameters: Record<string, string>;
  isWeb: boolean;
}

export interface TransportHandlers {
  onStart(meta: StartMeta): void;
  onAudio(chunk: Buffer): void;
  onDtmf?(digit: string): void;
  onTextInput?(text: string): void;
  onMark?(name: string): void;
  onStop(): void;
}

const OUT_FRAME_BYTES = 3200; // 400ms per media message keeps frames tidy

export class MediaTransport {
  private streamSid = "";
  private started = false;
  private stopped = false;
  isWeb = false;

  constructor(private ws: WebSocket, private handlers: TransportHandlers) {
    ws.on("message", (raw) => this.onMessage(raw));
    ws.on("close", () => this.emitStop());
    ws.on("error", () => this.emitStop());
  }

  private emitStop() {
    if (this.stopped) return;
    this.stopped = true;
    this.handlers.onStop();
  }

  private onMessage(raw: WebSocket.RawData) {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case "connected":
        break;
      case "start": {
        if (this.started) break;
        this.started = true;
        this.streamSid = msg.start?.streamSid ?? msg.streamSid ?? "";
        const customParameters: Record<string, string> = msg.start?.customParameters ?? {};
        this.isWeb = customParameters.web === "1";
        this.handlers.onStart({
          streamSid: this.streamSid,
          callSid: msg.start?.callSid,
          customParameters,
          isWeb: this.isWeb,
        });
        break;
      }
      case "media": {
        const payload = msg.media?.payload;
        if (typeof payload === "string" && payload.length > 0) {
          this.handlers.onAudio(Buffer.from(payload, "base64"));
        }
        break;
      }
      case "dtmf":
        if (msg.dtmf?.digit) this.handlers.onDtmf?.(String(msg.dtmf.digit));
        break;
      case "mark":
        if (msg.mark?.name) this.handlers.onMark?.(String(msg.mark.name));
        break;
      case "text-input":
        if (typeof msg.text === "string" && msg.text.trim()) this.handlers.onTextInput?.(msg.text.trim());
        break;
      case "stop":
        this.emitStop();
        break;
    }
  }

  private send(obj: unknown) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Send mulaw audio to the caller, framed into media messages. */
  sendAudio(mulaw: Buffer) {
    for (let off = 0; off < mulaw.length; off += OUT_FRAME_BYTES) {
      const frame = mulaw.subarray(off, Math.min(off + OUT_FRAME_BYTES, mulaw.length));
      this.send({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: frame.toString("base64") },
      });
    }
  }

  sendMark(name: string) {
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
  }

  /** Flush any audio Twilio has buffered but not yet played (barge-in). */
  clear() {
    this.send({ event: "clear", streamSid: this.streamSid });
  }

  /** Web-dialer-only side channel (captions, status). Silently ignored for Twilio. */
  sendUiEvent(obj: Record<string, unknown>) {
    if (this.isWeb) this.send(obj);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
