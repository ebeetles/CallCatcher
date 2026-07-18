import type { HistoryItem, LlmEvent, LlmProvider, LlmTurnRequest } from "../types.ts";

/**
 * Deterministic rule-based "brain" for keyless demos and integration tests.
 * Understands a handful of intents and exercises the real tool pipeline.
 */
export class MockLlm implements LlmProvider {
  readonly id = "mock";

  async *streamTurn(req: LlmTurnRequest): AsyncGenerator<LlmEvent> {
    const usage = { inputTokens: 100, outputTokens: 30, cacheReadTokens: 0 };

    const lastUser = [...req.history].reverse().find((h): h is Extract<HistoryItem, { role: "user" }> => h.role === "user");
    const lastItem = req.history[req.history.length - 1];
    const text = (lastUser?.text ?? "").toLowerCase();
    const has = (name: string) => req.tools.some((t) => t.name === name);

    // If we just got tool results back, confirm and wrap up.
    if (lastItem?.role === "tool_results") {
      yield* this.say("All set — I've passed that along to the team. Is there anything else I can help with?");
      yield { type: "done", stopReason: "end_turn", usage };
      return;
    }

    if (/\b(bye|goodbye|that'?s (all|everything)|no,? thank)/.test(text) && has("end_call")) {
      yield* this.say("Thanks so much for calling. Have a great day!");
      yield { type: "tool_call", call: { id: `mock_${Date.now()}`, name: "end_call", input: { reason: "caller finished" } } };
      yield { type: "done", stopReason: "tool_use", usage };
      return;
    }

    if (/(appointment|book|schedule|reserve)/.test(text) && has("request_appointment")) {
      const hasDetails = /(name is|i'?m |my number|phone)/.test(text) || /\d{3}/.test(text);
      if (!hasDetails) {
        yield* this.say("I'd be happy to help with that. Can I get your name, a phone number, and what day and time works best?");
        yield { type: "done", stopReason: "end_turn", usage };
        return;
      }
      yield* this.say("Perfect, let me get that request in for you.");
      yield {
        type: "tool_call",
        call: {
          id: `mock_${Date.now()}`,
          name: "request_appointment",
          input: {
            name: extractName(lastUser?.text ?? "") ?? "Caller",
            phone: extractPhone(lastUser?.text ?? "") ?? "unknown",
            service: "general appointment",
            preferred_times: lastUser?.text ?? "",
          },
        },
      };
      yield { type: "done", stopReason: "tool_use", usage };
      return;
    }

    if (/(message|call.*back|callback|leave a)/.test(text) && has("take_message")) {
      yield* this.say("Of course, I'll take that down.");
      yield {
        type: "tool_call",
        call: {
          id: `mock_${Date.now()}`,
          name: "take_message",
          input: {
            caller_name: extractName(lastUser?.text ?? "") ?? "Caller",
            callback_number: extractPhone(lastUser?.text ?? "") ?? "unknown",
            message: lastUser?.text ?? "Caller left a message.",
            urgency: /urgent|emergency|asap/.test(text) ? "urgent" : "normal",
          },
        },
      };
      yield { type: "done", stopReason: "tool_use", usage };
      return;
    }

    if (/(hour|open|close)/.test(text)) {
      // Read hours straight from the compiled system prompt to prove the prompt path works.
      const m = req.system.match(/currently (OPEN|CLOSED)\. Today's hours: ([^\n]+)/);
      if (m) {
        yield* this.say(`We're currently ${m[1].toLowerCase()}. Today's hours are ${m[2].replace(/\.$/, "")}. Anything else I can help with?`);
      } else {
        yield* this.say("You can find our hours on our website. Anything else I can help with?");
      }
      yield { type: "done", stopReason: "end_turn", usage };
      return;
    }

    const bizName = req.system.match(/receptionist for ([^,.\n]+)/)?.[1] ?? "the business";
    yield* this.say(`Thanks for calling ${bizName}! I can answer questions, take a message, or help book an appointment. What can I do for you?`);
    yield { type: "done", stopReason: "end_turn", usage };
  }

  private async *say(text: string): AsyncGenerator<LlmEvent> {
    // Stream word-by-word to exercise the sentence chunker like a real LLM would.
    for (const word of text.split(/(?<= )/)) {
      yield { type: "text", delta: word };
    }
  }
}

function extractPhone(text: string): string | undefined {
  const digitsWords = text
    .toLowerCase()
    .replace(/\bzero\b/g, "0")
    .replace(/\bone\b/g, "1")
    .replace(/\btwo\b/g, "2")
    .replace(/\bthree\b/g, "3")
    .replace(/\bfour\b/g, "4")
    .replace(/\bfive\b/g, "5")
    .replace(/\bsix\b/g, "6")
    .replace(/\bseven\b/g, "7")
    .replace(/\beight\b/g, "8")
    .replace(/\bnine\b/g, "9");
  const digits = digitsWords.replace(/[^0-9]/g, "");
  return digits.length >= 7 ? digits.slice(0, 11) : undefined;
}

function extractName(text: string): string | undefined {
  const m = text.match(/(?:name is|i'?m|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  return m?.[1];
}
