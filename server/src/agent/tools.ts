import type { ToolCall, ToolDef } from "../providers/types.ts";
import { appointments, messages, phoneNumbers, tenants } from "../db.ts";
import type { BusinessProfile } from "../types.ts";
import { tenantTwilio } from "../telephony/twilio.ts";
import { maskPhone } from "../security.ts";

export const TOOL_DEFS: Record<string, ToolDef> = {
  take_message: {
    name: "take_message",
    description:
      "Record a message for the business owner/team. Use after collecting the caller's name, callback number, and what the message is about.",
    inputSchema: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Caller's name" },
        callback_number: { type: "string", description: "Phone number to call back, as spoken" },
        message: { type: "string", description: "The message content, summarized clearly" },
        urgency: { type: "string", enum: ["normal", "urgent"], description: "Urgency level" },
      },
      required: ["message"],
    },
  },
  request_appointment: {
    name: "request_appointment",
    description:
      "Submit an appointment request (booking, reschedule, or cancellation) for the team to confirm. Use after collecting name, phone, service, and preferred day/time.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Caller's name" },
        phone: { type: "string", description: "Caller's phone number" },
        service: { type: "string", description: "Which service they want" },
        preferred_times: { type: "string", description: "Preferred days/times in the caller's words" },
        notes: { type: "string", description: "Anything else relevant" },
      },
      required: ["name", "preferred_times"],
    },
  },
  transfer_call: {
    name: "transfer_call",
    description:
      "Transfer the caller to a human at the business. Only use when the caller urgently needs a person and you have told them you are transferring.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the caller needs a human" },
      },
      required: ["reason"],
    },
  },
  end_call: {
    name: "end_call",
    description: "Hang up the call politely. Only use after saying goodbye and confirming the caller needs nothing else.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason, e.g. 'caller finished'" },
      },
      required: [],
    },
  },
};

export function toolDefsFor(enabled: string[], business: BusinessProfile): ToolDef[] {
  return enabled
    .filter((name) => TOOL_DEFS[name])
    .filter((name) => name !== "transfer_call" || !!business.forwardNumber)
    .map((name) => TOOL_DEFS[name]);
}

export interface ToolExecutionContext {
  business: BusinessProfile;
  callId?: string;
  /** Text the business's forward number when items are captured (real phone calls only). */
  notify?: boolean;
}

/** Coerce a spoken/typed US number to E.164, or undefined if we can't. */
function toE164(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  const d = trimmed.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return undefined;
}

/**
 * Fire-and-forget SMS to the business owner's forward number, sent from the
 * business's own Twilio line. Never throws — a failed text must not break the
 * call or stop the caller from hearing their confirmation.
 */
function notifyOwner(ctx: ToolExecutionContext, body: string): void {
  if (!ctx.notify) return;
  if (ctx.business.notifySms === false) return;
  // Send from the business's own line, through its tenant's Twilio account.
  const tenant = ctx.business.tenantId ? tenants.get(ctx.business.tenantId) : undefined;
  const client = tenantTwilio(tenant);
  if (!client) return;
  const to = toE164(ctx.business.notifyNumber || ctx.business.forwardNumber);
  const from = phoneNumbers.forBusiness(ctx.business.id)?.e164;
  if (!to || !from) return;
  console.log(`[notify] sending owner SMS ${maskPhone(from)} -> ${maskPhone(to)}`);
  client
    .sendSms(from, to, body)
    .then(() => console.log("[notify] SMS sent"))
    .catch((err) => console.error(`[notify] SMS to owner failed:`, err?.message ?? err));
}

export interface ToolOutcome {
  /** Result string fed back to the LLM. */
  result: string;
  /** Side-channel action the call session must perform. */
  action?: "end" | "transfer";
  isError?: boolean;
  /** Human-readable summary for the transcript. */
  summary: string;
}

export async function executeTool(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolOutcome> {
  const input = call.input ?? {};
  const str = (k: string) => {
    const v = input[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  switch (call.name) {
    case "take_message": {
      const rec = messages.create({
        businessId: ctx.business.id,
        callId: ctx.callId,
        callerName: str("caller_name"),
        callbackNumber: str("callback_number"),
        content: str("message") ?? "(no message content)",
        urgency: str("urgency") === "urgent" ? "urgent" : "normal",
      });
      notifyOwner(
        ctx,
        `${ctx.business.name} — new message via your receptionist${rec.urgency === "urgent" ? " [URGENT]" : ""}\n` +
          `From: ${rec.callerName ?? "caller"}${rec.callbackNumber ? ` (${rec.callbackNumber})` : ""}\n` +
          `${rec.content}`
      );
      return {
        result: `Message saved (id ${rec.id}). Confirm to the caller that the team will get back to them.`,
        summary: `📝 Took a message from ${rec.callerName ?? "caller"}${rec.callbackNumber ? ` (${rec.callbackNumber})` : ""}: "${rec.content}"`,
      };
    }
    case "request_appointment": {
      const rec = appointments.create({
        businessId: ctx.business.id,
        callId: ctx.callId,
        name: str("name"),
        phone: str("phone"),
        service: str("service"),
        preferredTimes: str("preferred_times"),
        notes: str("notes"),
      });
      notifyOwner(
        ctx,
        `${ctx.business.name} — new appointment request via your receptionist\n` +
          `${rec.name ?? "caller"}${rec.phone ? ` (${rec.phone})` : ""}\n` +
          `${rec.service ?? "service TBD"} — wants ${rec.preferredTimes ?? "time TBD"}` +
          `${rec.notes ? `\nNotes: ${rec.notes}` : ""}`
      );
      return {
        result: `Appointment request saved (id ${rec.id}). Tell the caller the team will confirm the exact time shortly.`,
        summary: `📅 Appointment request: ${rec.name ?? "caller"} — ${rec.service ?? "service TBD"} — ${rec.preferredTimes ?? "time TBD"}`,
      };
    }
    case "transfer_call": {
      if (!ctx.business.forwardNumber) {
        return {
          result: "Transfer is not available (no forwarding number configured). Offer to take a message instead.",
          isError: true,
          summary: "⚠️ Transfer requested but no forwarding number is configured",
        };
      }
      return {
        result: "Transferring the caller now.",
        action: "transfer",
        summary: `📞 Transferring caller to ${ctx.business.forwardNumber} — ${str("reason") ?? ""}`,
      };
    }
    case "end_call": {
      return {
        result: "Ending the call.",
        action: "end",
        summary: `👋 Call ended by assistant${str("reason") ? ` — ${str("reason")}` : ""}`,
      };
    }
    default:
      return { result: `Unknown tool: ${call.name}`, isError: true, summary: `⚠️ Unknown tool ${call.name}` };
  }
}
