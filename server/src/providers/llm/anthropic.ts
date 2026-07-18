import Anthropic from "@anthropic-ai/sdk";
import type { HistoryItem, LlmEvent, LlmProvider, LlmTurnRequest, ToolCall } from "../types.ts";
import { config } from "../../config.ts";

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

function toAnthropicMessages(history: HistoryItem[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const item of history) {
    if (item.role === "user") {
      out.push({ role: "user", content: item.text });
    } else if (item.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (item.text) content.push({ type: "text", text: item.text });
      for (const call of item.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: item.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError ?? false,
        })),
      });
    }
  }
  return out;
}

/**
 * Claude adapter for live calls. Streams text deltas the moment they arrive
 * (they feed straight into TTS), surfaces tool calls, and reports token usage.
 * The per-business system prompt is marked cacheable so multi-turn calls reuse it.
 */
export class AnthropicLlm implements LlmProvider {
  readonly id = "anthropic";

  async *streamTurn(req: LlmTurnRequest): AsyncGenerator<LlmEvent> {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    try {
      const stream = getClient().messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: [
            {
              type: "text",
              text: req.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: toAnthropicMessages(req.history),
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
        },
        { signal: req.signal }
      );

      // Track in-flight tool_use blocks while their input JSON streams in.
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      let stopReason: string | null = null;

      for await (const event of stream) {
        if (event.type === "message_start") {
          usage.inputTokens = event.message.usage.input_tokens ?? 0;
          usage.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text", delta: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const tb = toolBlocks.get(event.index);
            if (tb) tb.json += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const tb = toolBlocks.get(event.index);
          if (tb) {
            toolBlocks.delete(event.index);
            let input: Record<string, unknown> = {};
            try {
              input = tb.json ? JSON.parse(tb.json) : {};
            } catch {
              input = {};
            }
            const call: ToolCall = { id: tb.id, name: tb.name, input };
            yield { type: "tool_call", call };
          }
        } else if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason ?? stopReason;
          usage.outputTokens = event.usage.output_tokens ?? usage.outputTokens;
        }
      }

      yield {
        type: "done",
        stopReason: stopReason === "tool_use" ? "tool_use" : "end_turn",
        usage,
      };
    } catch (err: any) {
      if (req.signal.aborted || err?.name === "AbortError" || err?.name === "APIUserAbortError") {
        yield { type: "done", stopReason: "aborted", usage };
      } else {
        yield { type: "done", stopReason: "error", usage, error: String(err?.message ?? err) };
      }
    }
  }
}
