import type { BusinessProfile, CallMetrics, ReceptionistConfig, TurnLatency } from "../types.ts";
import type { HistoryItem } from "../providers/types.ts";
import { getLlm, getStt, getTts } from "../providers/registry.ts";
import type { SttStream } from "../providers/types.ts";
import { MediaTransport, type StartMeta } from "./transport.ts";
import { SentenceChunker } from "./sentenceChunker.ts";
import { runAgentTurn } from "../agent/agentLoop.ts";
import { calendarLive, executeTool, toolDefsFor } from "../agent/tools.ts";
import { LIVE_SCHEDULING_INSTRUCTIONS, resolveSystemPrompt } from "../promptFactory.ts";
import { calls, turns } from "../db.ts";
import { estimateCallCost } from "../costs.ts";

export interface TelephonyActions {
  transfer(callSid: string, to: string): Promise<void>;
  hangup(callSid: string): Promise<void>;
}

export interface SessionDeps {
  business: BusinessProfile;
  receptionist: ReceptionistConfig;
  telephony?: TelephonyActions;
  /** Overridable timers (tests shrink these). */
  timers?: Partial<typeof DEFAULT_TIMERS>;
}

export type DepsResolver = (customParameters: Record<string, string>) => SessionDeps | undefined;

const DEFAULT_TIMERS = {
  silencePromptMs: 14000,
  silenceHangupMs: 12000,
  playbackGraceMs: 4000,
};

/**
 * One live call. Wires transport <-> STT <-> agent loop <-> TTS with
 * barge-in, silence handling, tool side-effects, and metrics.
 */
export class CallSession {
  private history: HistoryItem[] = [];
  private callId = "";
  private callSid?: string;
  private stt?: SttStream;
  private system = "";
  private state: "starting" | "listening" | "responding" | "ended" = "starting";
  private currentAbort = new AbortController();
  private speakChain: Promise<void> = Promise.resolve();
  private taskChain: Promise<void> = Promise.resolve();
  private assistantAudioActive = false;
  private audioPlayedSinceMs = 0;
  /** Normalized text the assistant is currently speaking — used to reject echo of our own TTS. */
  private speakingText = "";
  private markCounter = 0;
  private pendingEndMark?: string;
  private markWaiters = new Map<string, () => void>();
  private silenceTimer?: NodeJS.Timeout;
  private silencePrompts = 0;
  private maxDurationTimer?: NodeJS.Timeout;
  private timers: typeof DEFAULT_TIMERS;

  private metrics: CallMetrics = {
    turns: 0,
    interruptions: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    llmCacheReadTokens: 0,
    ttsChars: 0,
    sttSeconds: 0,
  };
  private responseLatencies: number[] = [];

  readonly transport: MediaTransport;
  private deps!: SessionDeps;

  constructor(ws: any, private resolveDeps: DepsResolver) {
    this.timers = { ...DEFAULT_TIMERS };
    this.transport = new MediaTransport(ws, {
      onStart: (meta) => this.enqueueTask(() => this.handleStart(meta)),
      onAudio: (chunk) => this.handleAudio(chunk),
      onTextInput: (text) => {
        // Interrupt at arrival time — the queued task would otherwise wait
        // behind the very response it needs to cut off.
        this.interruptForNewInput();
        this.enqueueTask(() => this.handleUserText(text, "typed"));
      },
      onMark: (name) => this.handleMark(name),
      onDtmf: () => {},
      onStop: () => this.end("caller-hangup"),
    });
  }

  /** state is mutated by concurrent events across awaits — check via a call so TS doesn't over-narrow. */
  private ended(): boolean {
    return this.state === "ended";
  }

  /** Serialize user turns / lifecycle work so turns never interleave. */
  private enqueueTask(fn: () => Promise<void>) {
    this.taskChain = this.taskChain.then(fn).catch((err) => {
      console.error("[session] task error", err);
    });
  }

  private async handleStart(meta: StartMeta) {
    if (this.state !== "starting") return;
    const deps = this.resolveDeps(meta.customParameters);
    if (!deps) {
      // Don't log the raw params — they carry the caller's number and the stream token.
      console.warn(
        `[session] rejected stream (businessId=${meta.customParameters.businessId ?? "?"} web=${meta.customParameters.web === "1"})`
      );
      this.transport.sendUiEvent({ event: "status", status: "error", error: "Unknown business or no active receptionist" });
      this.state = "ended";
      this.transport.close();
      return;
    }
    this.deps = deps;
    this.timers = { ...DEFAULT_TIMERS, ...deps.timers };
    const { business, receptionist } = this.deps;
    this.callSid = meta.callSid;
    const from = meta.customParameters.from;
    const call = calls.create(business.id, meta.isWeb ? "web" : "phone", meta.callSid, from);
    this.callId = call.id;
    this.system = resolveSystemPrompt(receptionist.systemPrompt, business);
    // The stored prompt assumes no live calendar. When one is connected, override
    // that: the receptionist can now check availability and book in real time.
    if (calendarLive(business)) this.system += "\n\n" + LIVE_SCHEDULING_INSTRUCTIONS;

    console.log(
      `[call ${this.callId}] started (${meta.isWeb ? "web" : "phone"}) business=${business.name} llm=${receptionist.llm.provider}/${receptionist.llm.model} tts=${receptionist.voice.provider}`
    );
    this.transport.sendUiEvent({ event: "status", status: "connected", callId: this.callId });

    // Start STT (skip for pure typed sessions? cheap to start; web sends audio only in voice mode).
    try {
      const stt = getStt(receptionist.sttProvider);
      this.stt = await stt.start({
        onPartial: (text) => {
          if (this.assistantAudioActive && this.isLikelyEcho(text)) return;
          this.maybeBargeIn("partial", text);
          this.resetSilenceTimer();
          this.transport.sendUiEvent({ event: "transcript", role: "user", content: text, partial: true });
        },
        onFinal: (text) => {
          // A final that echoes our own speech isn't the caller talking — drop it.
          if (this.assistantAudioActive && this.isLikelyEcho(text)) return;
          this.interruptForNewInput();
          this.enqueueTask(() => this.handleUserText(text, "spoken"));
        },
        onSpeechStarted: () => {
          this.resetSilenceTimer();
        },
        onError: (err) => console.error(`[call ${this.callId}] STT error:`, err.message),
      });
    } catch (err: any) {
      console.error(`[call ${this.callId}] STT failed to start:`, err?.message ?? err);
    }

    this.maxDurationTimer = setTimeout(() => {
      this.enqueueTask(async () => {
        if (this.state === "ended") return;
        await this.speakDirect("I'm so sorry, but I have to wrap up now. Please call back any time. Goodbye!");
        await this.end("max-duration");
      });
    }, receptionist.maxCallSeconds * 1000);

    // Greeting.
    const greeting = receptionist.greeting;
    this.history.push({ role: "assistant", text: greeting });
    turns.add(this.callId, "assistant", greeting);
    this.transport.sendUiEvent({ event: "transcript", role: "assistant", content: greeting });
    this.state = "responding";
    const signal = this.newAbort();
    await this.speakSegment(greeting, signal);
    await this.finishSpeaking(signal);
    if (!this.ended()) {
      this.state = "listening";
      this.resetSilenceTimer();
    }
  }

  private handleAudio(chunk: Buffer) {
    if (this.state === "ended") return;
    this.metrics.sttSeconds += chunk.length / 8000;
    this.stt?.sendAudio(chunk);
  }

  private handleMark(name: string) {
    const waiter = this.markWaiters.get(name);
    if (waiter) {
      this.markWaiters.delete(name);
      waiter();
    }
    if (name === this.pendingEndMark) {
      this.assistantAudioActive = false;
    }
  }

  /** Barge-in: caller speaks while we're playing audio. */
  private maybeBargeIn(source: "vad" | "partial", text?: string) {
    if (this.state === "ended") return;
    if (!this.assistantAudioActive) return;
    // Ignore VAD blips in the first 300ms of playback (echo/noise).
    if (source === "vad" && Date.now() - this.audioPlayedSinceMs < 300) return;
    // Don't let our own TTS, echoing back through the line, interrupt us.
    if (source === "partial" && text && this.isLikelyEcho(text)) return;
    this.metrics.interruptions++;
    this.currentAbort.abort();
    this.transport.clear();
    this.assistantAudioActive = false;
    this.transport.sendUiEvent({ event: "status", status: "interrupted" });
  }

  /** Abort whatever is playing/generating because new user input just arrived. */
  private interruptForNewInput() {
    if (this.ended()) return;
    if (this.state === "responding" || this.assistantAudioActive) {
      this.currentAbort.abort();
      this.transport.clear();
      this.assistantAudioActive = false;
    }
  }

  private async handleUserText(text: string, via: "spoken" | "typed") {
    if (this.ended() || !this.callId) return;
    if (!text.trim()) return;
    // Let any aborted speech pipeline unwind before reusing the history.
    await this.speakChain.catch(() => {});
    this.clearSilenceTimer();
    this.silencePrompts = 0;
    this.metrics.turns++;
    this.history.push({ role: "user", text });
    turns.add(this.callId, "user", text);
    this.transport.sendUiEvent({ event: "transcript", role: "user", content: text, via });
    await this.respond();
  }

  private newAbort(): AbortSignal {
    this.currentAbort = new AbortController();
    // Each new assistant utterance is a fresh echo source.
    this.speakingText = "";
    return this.currentAbort.signal;
  }

  private static norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /**
   * True when an inbound transcript is really our own TTS echoing back through
   * the caller's line — Deepgram happily transcribes it and it looks like the
   * caller "interrupting" with the exact words the assistant just said.
   */
  private isLikelyEcho(text: string): boolean {
    const said = CallSession.norm(this.speakingText);
    const heard = CallSession.norm(text);
    if (!said || !heard) return false;
    if (said.includes(heard)) return true;
    const saidWords = new Set(said.split(" "));
    const heardWords = heard.split(" ");
    const hits = heardWords.filter((w) => saidWords.has(w)).length;
    return hits / heardWords.length >= 0.6;
  }

  private async respond() {
    const { business, receptionist } = this.deps;
    this.state = "responding";
    const signal = this.newAbort();
    const startedAt = Date.now();
    const chunker = new SentenceChunker();
    let ttsFirstAudioMs: number | undefined;
    let spokeAnything = false;

    const speakOne = (segment: string) => {
      this.speakChain = this.speakChain.then(async () => {
        if (signal.aborted || this.state === "ended") return;
        const first = !spokeAnything;
        spokeAnything = true;
        await this.speakSegment(segment, signal);
        if (first && ttsFirstAudioMs === undefined) ttsFirstAudioMs = Date.now() - startedAt;
      });
    };

    const result = await runAgentTurn({
      llm: getLlm(receptionist.llm.provider),
      model: receptionist.llm.model,
      maxTokens: receptionist.llm.maxTokens,
      system: this.system,
      history: this.history,
      tools: toolDefsFor(receptionist.tools, business),
      signal,
      onTextDelta: (delta) => {
        for (const seg of chunker.push(delta)) speakOne(seg);
      },
      onToolExecuted: (call, outcome) => {
        turns.add(this.callId, "tool", outcome.summary);
        this.transport.sendUiEvent({ event: "transcript", role: "tool", content: outcome.summary });
      },
      executeTool: (call) => executeTool(call, { business, callId: this.callId, notify: !this.transport.isWeb }),
    });

    const rest = chunker.flush();
    if (rest && !signal.aborted) speakOne(rest);
    await this.finishSpeaking(signal);

    this.metrics.llmInputTokens += result.usage.inputTokens;
    this.metrics.llmOutputTokens += result.usage.outputTokens;
    this.metrics.llmCacheReadTokens += result.usage.cacheReadTokens;

    const latency: TurnLatency = {
      llmFirstTokenMs: result.firstTokenMs,
      ttsFirstAudioMs,
      totalMs: Date.now() - startedAt,
    };
    if (ttsFirstAudioMs !== undefined) this.responseLatencies.push(ttsFirstAudioMs);

    if (result.fullText.trim()) {
      turns.add(this.callId, "assistant", result.fullText.trim(), {
        truncated: result.aborted,
        latency,
      });
      this.transport.sendUiEvent({
        event: "transcript",
        role: "assistant",
        content: result.fullText.trim(),
        truncated: result.aborted,
        latency,
      });
    }

    if (this.ended()) return;

    if (result.error) {
      console.error(`[call ${this.callId}] LLM error:`, result.error);
      await this.speakDirect("I'm sorry, I'm having a little trouble right now. Could you say that again?");
    }

    if (result.endAction === "end") {
      await this.end("assistant-ended");
      return;
    }
    if (result.endAction === "transfer") {
      await this.doTransfer();
      return;
    }

    if (!result.aborted) {
      this.state = "listening";
      this.resetSilenceTimer();
    }
    // If aborted, a new user turn is already queued and will run next.
  }

  /** Speak a standalone line (greeting/silence prompt/wrap-up) and log it. */
  private async speakDirect(text: string) {
    if (this.state === "ended") return;
    this.history.push({ role: "assistant", text });
    turns.add(this.callId, "assistant", text);
    this.transport.sendUiEvent({ event: "transcript", role: "assistant", content: text });
    const signal = this.newAbort();
    await this.speakSegment(text, signal);
    await this.finishSpeaking(signal);
  }

  private async speakSegment(text: string, signal: AbortSignal) {
    if (signal.aborted || this.state === "ended") return;
    // Remember what we're saying so its echo can't interrupt us.
    this.speakingText += " " + text;
    const { receptionist } = this.deps;
    const tts = getTts(receptionist.voice.provider);
    try {
      let firstChunk = true;
      for await (const chunk of tts.synthesize(text, receptionist.voice.voiceId, signal)) {
        if (signal.aborted || this.ended()) return;
        if (firstChunk) {
          firstChunk = false;
          if (!this.assistantAudioActive) {
            this.assistantAudioActive = true;
            this.audioPlayedSinceMs = Date.now();
          }
        }
        this.transport.sendAudio(chunk);
      }
      this.metrics.ttsChars += text.length;
    } catch (err: any) {
      if (!signal.aborted) {
        console.error(`[call ${this.callId}] TTS error:`, err?.message ?? err);
      }
    }
  }

  /**
   * Wait for queued speech to be handed to the transport, then drop an
   * end-mark so we learn when the caller actually finished hearing it.
   */
  private async finishSpeaking(signal: AbortSignal) {
    await this.speakChain.catch(() => {});
    if (signal.aborted || this.state === "ended" || !this.assistantAudioActive) return;
    const mark = `resp-${++this.markCounter}`;
    this.pendingEndMark = mark;
    this.transport.sendMark(mark);
    await this.waitForMark(mark, this.timers.playbackGraceMs);
  }

  private waitForMark(name: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.markWaiters.delete(name);
        // Assume playback finished if the peer never echoes marks (web dialer does, Twilio does).
        if (this.pendingEndMark === name) this.assistantAudioActive = false;
        resolve();
      }, timeoutMs);
      this.markWaiters.set(name, () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private async doTransfer() {
    const { business } = this.deps;
    const to = business.forwardNumber!;
    this.transport.sendUiEvent({ event: "status", status: "transferring", to });
    if (this.callSid && this.deps.telephony) {
      try {
        await this.deps.telephony.transfer(this.callSid, to);
        await this.end("transferred", { skipHangup: true });
        return;
      } catch (err: any) {
        console.error(`[call ${this.callId}] transfer failed:`, err?.message ?? err);
        await this.speakDirect(
          "I'm sorry, I wasn't able to connect you just now. Can I take a message instead?"
        );
        this.state = "listening";
        this.resetSilenceTimer();
        return;
      }
    }
    // Web demo: no real leg to dial.
    await this.end("transferred", { skipHangup: true });
  }

  private resetSilenceTimer() {
    if (this.state === "ended") return;
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.enqueueTask(async () => {
        if (this.state !== "listening") return;
        this.silencePrompts++;
        if (this.silencePrompts === 1) {
          await this.speakDirect("Are you still there?");
          this.state = "listening";
          this.clearSilenceTimer();
          this.silenceTimer = setTimeout(() => {
            this.enqueueTask(async () => {
              if (this.state !== "listening") return;
              await this.speakDirect("It sounds like we got disconnected. Feel free to call back any time. Goodbye!");
              await this.end("silence");
            });
          }, this.timers.silenceHangupMs);
        }
      });
    }, this.timers.silencePromptMs);
  }

  private clearSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  async end(reason: string, opts?: { skipHangup?: boolean }) {
    if (this.state === "ended") return;
    this.state = "ended";
    this.clearSilenceTimer();
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.currentAbort.abort();
    try {
      await this.stt?.close();
    } catch {
      // ignore
    }

    if (this.callId) {
      const startedAt = calls.get(this.callId)?.startedAt;
      const durationSec = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : 0;
      const avg =
        this.responseLatencies.length > 0
          ? Math.round(this.responseLatencies.reduce((a, b) => a + b, 0) / this.responseLatencies.length)
          : undefined;
      this.metrics.avgResponseMs = avg;
      this.metrics.estimatedCostUsd = estimateCallCost({
        durationSec,
        channel: this.transport.isWeb ? "web" : "phone",
        sttProvider: this.deps.receptionist.sttProvider,
        sttSeconds: this.metrics.sttSeconds,
        llmModel: this.deps.receptionist.llm.model,
        llmInputTokens: this.metrics.llmInputTokens,
        llmOutputTokens: this.metrics.llmOutputTokens,
        llmCacheReadTokens: this.metrics.llmCacheReadTokens,
        ttsProvider: this.deps.receptionist.voice.provider,
        ttsChars: this.metrics.ttsChars,
      });
      calls.end(this.callId, reason, this.metrics);
      console.log(`[call ${this.callId}] ended (${reason}) cost≈$${this.metrics.estimatedCostUsd}`);
    }

    this.transport.sendUiEvent({ event: "status", status: "ended", reason });

    // Belt-and-braces: make sure the phone leg actually hangs up.
    if (!opts?.skipHangup && reason !== "caller-hangup" && this.callSid && this.deps.telephony) {
      try {
        await this.deps.telephony.hangup(this.callSid);
      } catch {
        // closing the stream socket ends <Connect><Stream> calls anyway
      }
    }
    this.transport.close();
  }
}
