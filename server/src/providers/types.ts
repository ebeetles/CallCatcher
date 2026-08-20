/** Provider-neutral interfaces for the voice pipeline. */

// ---------- STT ----------

export interface SttCallbacks {
  /** Interim transcript (may change). Used for UI + early barge-in confidence. */
  onPartial(text: string): void;
  /** Finalized utterance — triggers an agent turn. `confidence` (0-1) is the
   *  provider's confidence in the transcript, used for bilingual language
   *  detection when two streams race on the same audio. */
  onFinal(text: string, confidence?: number): void;
  /** Voice activity detected — triggers barge-in while the agent is speaking. */
  onSpeechStarted(): void;
  onError(err: Error): void;
}

export interface SttStream {
  /** Feed 8kHz mulaw audio. */
  sendAudio(chunk: Buffer): void;
  close(): Promise<void>;
}

export interface SttOptions {
  /** BCP-47-ish language code for the recognizer, e.g. "en" or "zh". Omit for
   *  the provider's default (English). */
  language?: string;
}

export interface SttProvider {
  readonly id: string;
  start(callbacks: SttCallbacks, opts?: SttOptions): Promise<SttStream>;
}

// ---------- LLM ----------

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type HistoryItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool_results"; results: Array<{ id: string; content: string; isError?: boolean }> };

export interface LlmTurnRequest {
  system: string;
  history: HistoryItem[];
  tools: ToolDef[];
  model: string;
  maxTokens: number;
  signal: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "aborted" | "error"; usage: LlmUsage; error?: string };

export interface LlmProvider {
  readonly id: string;
  streamTurn(req: LlmTurnRequest): AsyncGenerator<LlmEvent>;
}

// ---------- TTS ----------

export interface TtsProvider {
  readonly id: string;
  /** Synthesize one sentence/segment. Yields 8kHz mulaw audio chunks. */
  synthesize(text: string, voiceId: string, signal: AbortSignal): AsyncGenerator<Buffer>;
  /** Voices the operator can pick from in the dashboard. */
  voices(): Array<{ id: string; label: string }>;
}
