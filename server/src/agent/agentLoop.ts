import type { HistoryItem, LlmProvider, LlmUsage, ToolCall, ToolDef } from "../providers/types.ts";
import type { ToolOutcome } from "./tools.ts";

export interface AgentLoopDeps {
  llm: LlmProvider;
  model: string;
  maxTokens: number;
  system: string;
  /** Mutated in place: assistant turns and tool results are appended. */
  history: HistoryItem[];
  tools: ToolDef[];
  signal: AbortSignal;
  onTextDelta(delta: string): void;
  /** Called after each tool executes (for transcript logging). */
  onToolExecuted?(call: ToolCall, outcome: ToolOutcome): void;
  executeTool(call: ToolCall): Promise<ToolOutcome>;
  maxIterations?: number;
}

export interface AgentLoopResult {
  aborted: boolean;
  error?: string;
  endAction?: "end" | "transfer";
  usage: LlmUsage;
  firstTokenMs?: number;
  /** All assistant text produced this turn (across tool iterations). */
  fullText: string;
}

/**
 * One full agent turn: stream the LLM, execute any tool calls, feed results
 * back, repeat until the model stops calling tools. Text deltas flow to the
 * caller in real time (voice pipes them into TTS; chat pipes them to SSE).
 */
export async function runAgentTurn(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const started = Date.now();
  let firstTokenMs: number | undefined;
  let fullText = "";
  let endAction: "end" | "transfer" | undefined;
  const maxIterations = deps.maxIterations ?? 4;

  for (let iter = 0; iter < maxIterations; iter++) {
    let iterText = "";
    const toolCalls: ToolCall[] = [];
    let stopReason: "end_turn" | "tool_use" | "aborted" | "error" = "end_turn";
    let error: string | undefined;

    for await (const event of deps.llm.streamTurn({
      system: deps.system,
      history: deps.history,
      tools: deps.tools,
      model: deps.model,
      maxTokens: deps.maxTokens,
      signal: deps.signal,
    })) {
      if (event.type === "text") {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
        iterText += event.delta;
        fullText += event.delta;
        deps.onTextDelta(event.delta);
      } else if (event.type === "tool_call") {
        toolCalls.push(event.call);
      } else if (event.type === "done") {
        stopReason = event.stopReason;
        error = event.error;
        usage.inputTokens += event.usage.inputTokens;
        usage.outputTokens += event.usage.outputTokens;
        usage.cacheReadTokens += event.usage.cacheReadTokens;
      }
    }

    if (stopReason === "aborted") {
      // Barge-in: record what was actually said so far.
      if (iterText.trim()) deps.history.push({ role: "assistant", text: iterText.trim() });
      return { aborted: true, usage, firstTokenMs, fullText };
    }
    if (stopReason === "error") {
      if (iterText.trim()) deps.history.push({ role: "assistant", text: iterText.trim() });
      return { aborted: false, error, usage, firstTokenMs, fullText };
    }

    deps.history.push({
      role: "assistant",
      text: iterText.trim(),
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });

    if (stopReason !== "tool_use" || toolCalls.length === 0) {
      return { aborted: false, endAction, usage, firstTokenMs, fullText };
    }

    const results: Array<{ id: string; content: string; isError?: boolean }> = [];
    for (const call of toolCalls) {
      const outcome = await deps.executeTool(call);
      deps.onToolExecuted?.(call, outcome);
      if (outcome.action) endAction = outcome.action;
      results.push({ id: call.id, content: outcome.result, isError: outcome.isError });
    }
    deps.history.push({ role: "tool_results", results });

    // Terminal actions: don't ask the model to continue — the session takes over.
    if (endAction) {
      return { aborted: false, endAction, usage, firstTokenMs, fullText };
    }
  }

  return { aborted: false, endAction, usage, firstTokenMs, fullText };
}
