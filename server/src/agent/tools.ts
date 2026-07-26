import type { ToolCall, ToolDef } from "../providers/types.ts";
import { appointments, calendarIntegrations, messages, phoneNumbers, tenants } from "../db.ts";
import type { BusinessProfile } from "../types.ts";
import { tenantTwilio } from "../telephony/twilio.ts";
import { maskPhone } from "../security.ts";
import { bookEvent, checkAvailability } from "../integrations/googleCalendar.ts";

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
  check_availability: {
    name: "check_availability",
    description:
      "Check the business's live calendar for a specific time. Use before booking to confirm the slot is open. Resolve the caller's spoken time (e.g. 'next Tuesday at 2pm') to a concrete local start by reading the date from the 'Dates for the coming days' list in the current-time context — do not compute weekday dates yourself.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Requested start as local wall-clock time, ISO format 'YYYY-MM-DDTHH:MM:SS' (no timezone).",
        },
        duration_min: { type: "number", description: "Appointment length in minutes. Omit to use the service default." },
        service: { type: "string", description: "Which service, to infer a sensible default duration." },
      },
      required: ["start"],
    },
  },
  book_appointment: {
    name: "book_appointment",
    description:
      "Book a confirmed appointment directly on the business's live calendar. Only after you've collected name, phone, service, and confirmed the exact time is open. The caller can rely on this time — it is booked immediately.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Caller's name" },
        phone: { type: "string", description: "Caller's phone number" },
        service: { type: "string", description: "Which service they're booking" },
        start: {
          type: "string",
          description: "Confirmed start as local wall-clock time, ISO format 'YYYY-MM-DDTHH:MM:SS' (no timezone).",
        },
        duration_min: { type: "number", description: "Appointment length in minutes. Omit to use the service default." },
        notes: { type: "string", description: "Anything else relevant" },
      },
      required: ["name", "start"],
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

/** True when this business can book on a live calendar right now. */
export function calendarLive(business: BusinessProfile): boolean {
  return !!calendarIntegrations.connected(business.id);
}

export function toolDefsFor(enabled: string[], business: BusinessProfile): ToolDef[] {
  const live = calendarLive(business);
  const names: string[] = [];
  for (const name of enabled) {
    // When a live calendar is connected, the "appointment" capability upgrades
    // from a request-for-callback into real availability + direct booking.
    if (name === "request_appointment") {
      if (live) names.push("check_availability", "book_appointment");
      else names.push("request_appointment");
      continue;
    }
    if (name === "transfer_call" && !business.forwardNumber) continue;
    if (TOOL_DEFS[name]) names.push(name);
  }
  return names.filter((name) => TOOL_DEFS[name]).map((name) => TOOL_DEFS[name]);
}

export interface ToolExecutionContext {
  business: BusinessProfile;
  callId?: string;
  /** Text the business's forward number when items are captured (real phone calls only). */
  notify?: boolean;
}

/** Default appointment length: explicit > matching service's duration > 30 min. */
function durationFor(business: BusinessProfile, service: string | undefined, explicit: unknown): number {
  if (typeof explicit === "number" && explicit > 0) return Math.round(explicit);
  if (service) {
    const match = business.services.find((s) => s.name.toLowerCase().includes(service.toLowerCase()) || service.toLowerCase().includes(s.name.toLowerCase()));
    if (match?.durationMin) return match.durationMin;
  }
  return 30;
}

/** Human-friendly rendering of a local wall-clock start in the business timezone. */
function describeSlot(localIso: string, timeZone: string): string {
  const naive = localIso.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
  const d = new Date(naive + "Z");
  if (Number.isNaN(d.getTime())) return localIso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return localIso;
  }
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
    case "check_availability": {
      const start = str("start");
      if (!start) {
        return { result: "Provide a concrete start time first.", isError: true, summary: "⚠️ check_availability missing start" };
      }
      const durationMin = durationFor(ctx.business, str("service"), input.duration_min);
      try {
        const avail = await checkAvailability({ start, durationMin, business: ctx.business });
        const spoken = describeSlot(start, ctx.business.timezone);
        return {
          result: avail.free
            ? `That slot (${spoken}, ${durationMin} min) is OPEN. If the caller wants it, collect any missing details and call book_appointment with the same start.`
            : `That slot (${spoken}) is BUSY. Offer the caller a different time and check again.`,
          summary: `🔎 Checked ${spoken}: ${avail.free ? "open" : "busy"}`,
        };
      } catch (err) {
        return {
          result: "Couldn't reach the calendar just now. Offer to take the details and tell the caller the team will confirm.",
          isError: true,
          summary: `⚠️ Availability check failed: ${(err as Error)?.message ?? err}`,
        };
      }
    }
    case "book_appointment": {
      const start = str("start");
      const name = str("name");
      if (!start) {
        return { result: "Confirm the exact start time before booking.", isError: true, summary: "⚠️ book_appointment missing start" };
      }
      const service = str("service");
      const durationMin = durationFor(ctx.business, service, input.duration_min);
      const spoken = describeSlot(start, ctx.business.timezone);
      try {
        const event = await bookEvent({
          start,
          durationMin,
          business: ctx.business,
          summary: `${service ?? "Appointment"} — ${name ?? "caller"}`,
          description: [
            name ? `Name: ${name}` : "",
            str("phone") ? `Phone: ${str("phone")}` : "",
            service ? `Service: ${service}` : "",
            str("notes") ? `Notes: ${str("notes")}` : "",
            "Booked by CallCatcher receptionist.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        const rec = appointments.create({
          businessId: ctx.business.id,
          callId: ctx.callId,
          name,
          phone: str("phone"),
          service,
          preferredTimes: spoken,
          notes: str("notes"),
          status: "confirmed",
        });
        notifyOwner(
          ctx,
          `${ctx.business.name} — appointment BOOKED via your receptionist\n` +
            `${name ?? "caller"}${str("phone") ? ` (${str("phone")})` : ""}\n` +
            `${service ?? "service"} — ${spoken}` +
            `${str("notes") ? `\nNotes: ${str("notes")}` : ""}`
        );
        return {
          result: `Booked on the calendar for ${spoken} (id ${rec.id}). Confirm the exact time to the caller in one sentence.`,
          summary: `✅ Booked ${name ?? "caller"} — ${service ?? "appointment"} — ${spoken}${event.htmlLink ? ` (${event.htmlLink})` : ""}`,
        };
      } catch (err) {
        // Never lose the booking: fall back to a request the team confirms.
        const rec = appointments.create({
          businessId: ctx.business.id,
          callId: ctx.callId,
          name,
          phone: str("phone"),
          service,
          preferredTimes: spoken,
          notes: str("notes"),
        });
        notifyOwner(
          ctx,
          `${ctx.business.name} — appointment request (calendar booking failed, please confirm)\n` +
            `${name ?? "caller"}${str("phone") ? ` (${str("phone")})` : ""}\n` +
            `${service ?? "service"} — wants ${spoken}`
        );
        return {
          result: `Couldn't finalize on the calendar, but the request is saved (id ${rec.id}). Tell the caller the team will confirm the exact time shortly — don't promise it's locked in.`,
          isError: true,
          summary: `⚠️ Booking failed, saved as request: ${(err as Error)?.message ?? err}`,
        };
      }
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
