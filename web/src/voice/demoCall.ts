import { base64ToBytes, bytesToBase64, float32ToMulaw, mulawToFloat32, resample } from "./mulaw";

/**
 * Browser voice client for the public landing-page demo. Captures the mic,
 * encodes to 8 kHz mu-law, and drives the *real* CallCatcher media-stream
 * pipeline (the same one a phone call uses) over a WebSocket — then plays the
 * receptionist's mu-law audio back. No dependency on the dashboard's auth: it
 * fetches a single-use demo token from the public endpoint first.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const WS_BASE = (API_BASE || window.location.origin).replace(/^http/, "ws");
const TARGET_RATE = 8000;

export type DemoCallStatus = "requesting-mic" | "connecting" | "live" | "ended";

export interface DemoCallHandlers {
  onStatus(status: DemoCallStatus, detail?: string): void;
  onTranscript(role: "user" | "assistant" | "tool", text: string, partial?: boolean): void;
  onError(message: string): void;
  onLevel?(level: number): void;
}

export interface DemoCallController {
  stop(): void;
}

export function startDemoCall(handlers: DemoCallHandlers): DemoCallController {
  let ws: WebSocket | undefined;
  let ctx: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let processor: ScriptProcessorNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let sink: GainNode | undefined;
  let stopped = false;
  const streamSid = "MZweb" + Math.random().toString(36).slice(2, 8);

  // Playback scheduling: queue mu-law audio into buffers played back-to-back.
  let nextPlayTime = 0;
  const scheduled = new Set<AudioBufferSourceNode>();

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const cleanup = (status: DemoCallStatus, detail?: string) => {
    if (stopped) return;
    stopped = true;
    try { processor?.disconnect(); } catch { /* noop */ }
    try { source?.disconnect(); } catch { /* noop */ }
    try { sink?.disconnect(); } catch { /* noop */ }
    stream?.getTracks().forEach((t) => t.stop());
    try { ws?.close(); } catch { /* noop */ }
    void ctx?.close().catch(() => {});
    handlers.onStatus(status, detail);
  };

  const stop = () => {
    send({ event: "stop" });
    cleanup("ended");
  };

  const playMulaw = (bytes: Uint8Array) => {
    if (!ctx) return;
    const samples = mulawToFloat32(bytes);
    const buf = ctx.createBuffer(1, samples.length, TARGET_RATE);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(nextPlayTime, ctx.currentTime + 0.02);
    src.start(startAt);
    nextPlayTime = startAt + buf.duration;
    scheduled.add(src);
    src.onended = () => scheduled.delete(src);
  };

  const flushPlayback = () => {
    for (const src of scheduled) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    scheduled.clear();
    nextPlayTime = ctx ? ctx.currentTime : 0;
  };

  const onMessage = (raw: string) => {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.event) {
      case "media":
        if (typeof msg.media?.payload === "string") playMulaw(base64ToBytes(msg.media.payload));
        break;
      case "mark": {
        // Echo the mark back when the buffered audio it trails should be done
        // playing, so the session learns when the caller actually heard it.
        const delayMs = ctx ? Math.max(0, (nextPlayTime - ctx.currentTime) * 1000) : 0;
        const name = msg.mark?.name;
        if (name) window.setTimeout(() => send({ event: "mark", streamSid, mark: { name } }), delayMs);
        break;
      }
      case "clear":
        flushPlayback();
        break;
      case "transcript":
        if (msg.role && typeof msg.content === "string") handlers.onTranscript(msg.role, msg.content, !!msg.partial);
        break;
      case "status":
        if (msg.status === "connected") handlers.onStatus("live");
        else if (msg.status === "ended") cleanup("ended", msg.reason);
        else if (msg.status === "error") { handlers.onError(msg.error || "Demo unavailable"); cleanup("ended"); }
        break;
    }
  };

  const run = async () => {
    try {
      handlers.onStatus("requesting-mic");
      const tokenRes = await fetch(`${API_BASE}/api/public/demo-voice-token`, { method: "POST" });
      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => undefined);
        throw new Error(body?.error || (tokenRes.status === 429 ? "The live demo is busy — try again shortly." : "Couldn't start the demo."));
      }
      const { token } = (await tokenRes.json()) as { token: string };

      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (stopped) return;

      ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      nextPlayTime = ctx.currentTime;
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(4096, 1, 1);
      sink = ctx.createGain();
      sink.gain.value = 0; // keep the graph running without echoing the mic to speakers
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);

      processor.onaudioprocess = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        handlers.onLevel?.(Math.min(1, Math.sqrt(sum / input.length) * 4));
        const down = resample(input, ctx!.sampleRate, TARGET_RATE);
        const mulaw = float32ToMulaw(down);
        send({ event: "media", streamSid, media: { payload: bytesToBase64(mulaw) } });
      };

      handlers.onStatus("connecting");
      ws = new WebSocket(`${WS_BASE}/media-stream`);
      ws.onopen = () => {
        send({
          event: "start",
          streamSid,
          start: {
            streamSid,
            customParameters: { token, web: "1", from: "+15550000000" },
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          },
        });
      };
      ws.onmessage = (ev) => onMessage(typeof ev.data === "string" ? ev.data : "");
      ws.onerror = () => { if (!stopped) handlers.onError("Connection error."); };
      ws.onclose = () => cleanup("ended");
    } catch (err: any) {
      const name = err?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        handlers.onError("Microphone access was blocked. Allow it and try again.");
      } else if (name === "NotFoundError") {
        handlers.onError("No microphone found.");
      } else {
        handlers.onError(err?.message ? String(err.message) : "Couldn't start the demo.");
      }
      cleanup("ended");
    }
  };

  void run();
  return { stop };
}
