import type { HistoryItem, LlmEvent, LlmProvider, LlmTurnRequest, ToolCall } from "../types.ts";
import { config } from "../../config.ts";

function toOpenAiMessages(system: string, history: HistoryItem[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const item of history) {
    if (item.role === "user") {
      out.push({ role: "user", content: item.text });
    } else if (item.role === "assistant") {
      const msg: any = { role: "assistant", content: item.text || null };
      if (item.toolCalls?.length) {
        msg.tool_calls = item.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
      }
      out.push(msg);
    } else {
      for (const r of item.results) {
        out.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

/** OpenAI chat-completions adapter (raw SSE — no SDK dependency needed). */
export class OpenAiLlm implements LlmProvider {
  readonly id = "openai";

  async *streamTurn(req: LlmTurnRequest): AsyncGenerator<LlmEvent> {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: req.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.openaiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: req.maxTokens,
          messages: toOpenAiMessages(req.system, req.history),
          tools: req.tools.length
            ? req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              }))
            : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        yield { type: "done", stopReason: "error", usage, error: `OpenAI ${res.status}: ${body.slice(0, 300)}` };
        return;
      }

      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      let finish: string | null = null;
      let buffer = "";
      const decoder = new TextDecoder();

      const reader = (res.body as any).getReader
        ? (res.body as any).getReader()
        : undefined;

      const processLine = function* (line: string): Generator<LlmEvent> {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          return;
        }
        if (json.usage) {
          usage.inputTokens = json.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = json.usage.completion_tokens ?? usage.outputTokens;
          usage.cacheReadTokens = json.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
        const choice = json.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text", delta: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!toolAcc.has(idx)) toolAcc.set(idx, { id: tc.id ?? `call_${idx}`, name: "", args: "" });
          const acc = toolAcc.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      };

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            yield* processLine(line);
          }
        }
      }

      // Flush accumulated tool calls once the stream is complete.
      for (const acc of toolAcc.values()) {
        let input: Record<string, unknown> = {};
        try {
          input = acc.args ? JSON.parse(acc.args) : {};
        } catch {
          input = {};
        }
        const call: ToolCall = { id: acc.id, name: acc.name, input };
        yield { type: "tool_call", call };
      }

      yield {
        type: "done",
        stopReason: finish === "tool_calls" ? "tool_use" : "end_turn",
        usage,
      };
    } catch (err: any) {
      if (req.signal.aborted || err?.name === "AbortError") {
        yield { type: "done", stopReason: "aborted", usage };
      } else {
        yield { type: "done", stopReason: "error", usage, error: String(err?.message ?? err) };
      }
    }
  }
}
