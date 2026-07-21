import type { BusinessProfile, ReceptionistConfig } from "./types.ts";
import type { BusinessInput } from "./db.ts";
import { businesses, receptionists, tenants } from "./db.ts";
import { ALL_TOOLS, buildGreeting, buildSystemPrompt } from "./promptFactory.ts";
import { config, defaultProviders } from "./config.ts";

/**
 * The built-in demo receptionist that powers the public landing-page demo —
 * CallCatcher's own AI receptionist, answering questions about the product.
 * Two flavors share one profile:
 *
 *  - Text demo (POST /api/public/demo-chat): runs a standalone agent turn
 *    against the in-memory DEMO_PROFILE with simulated (non-persisting) tools.
 *  - Voice demo (browser mic → /media-stream): runs the *real* CallSession
 *    pipeline, so it needs a real DB business + receptionist. ensureDemoSeed()
 *    creates those idempotently under a dedicated, hidden demo tenant.
 *
 * The demo tenant is never billed, never adopted (its businesses have a
 * non-null tenant_id), and never surfaces in a real operator's dashboard.
 */

export const DEMO_TENANT_ID = "tnt_demo";
/** Hard cap on a demo voice call — the session auto-wraps at this many seconds. */
export const DEMO_MAX_CALL_SECONDS = 60;

export const DEMO_BUSINESS_INPUT: BusinessInput = {
  name: "CallCatcher",
  industry: "AI phone receptionist platform",
  description:
    "CallCatcher gives a small business an AI receptionist on a real phone number — it answers calls day and night, quotes prices, books appointments, takes messages, and logs every call. Agencies run receptionists for many clients from one dashboard.",
  timezone: "America/Los_Angeles",
  website: "https://callcatcher.example.com",
  email: "hello@callcatcher.example.com",
  forwardNumber: "+15555550123",
  notifySms: false,
  // A software product answers around the clock.
  hours: {
    mon: { open: true, ranges: [{ start: "00:00", end: "23:59" }] },
    tue: { open: true, ranges: [{ start: "00:00", end: "23:59" }] },
    wed: { open: true, ranges: [{ start: "00:00", end: "23:59" }] },
    thu: { open: true, ranges: [{ start: "00:00", end: "23:59" }] },
    fri: { open: true, ranges: [{ start: "00:00", end: "23:59" }] },
    sat: { open: true, ranges: [{ start: "00:00", end: "23:59" }] },
    sun: { open: true, ranges: [{ start: "00:00", end: "23:59" }] },
  },
  services: [
    { name: "Free trial", price: "Free for 14 days", description: "Every feature, one business, no credit card required." },
    { name: "Starter plan", price: "$49/month", description: "One client business on a real phone line — call logs, inbox, and SMS alerts." },
    { name: "Pro plan", price: "$149/month", description: "Up to five client businesses and premium ElevenLabs voices." },
    { name: "Scale plan", price: "$399/month", description: "Up to fifteen businesses and serious call volume for a full roster." },
  ],
  faqs: [
    { question: "What is CallCatcher?", answer: "CallCatcher gives a small business an AI receptionist on a real phone number. It answers calls day and night, quotes prices, books appointments, takes messages, and logs every call with a full transcript." },
    { question: "Do I need a new phone number?", answer: "You can buy a local number in one click, or bring the one the business already has — whichever you prefer." },
    { question: "How long does setup take?", answer: "Just a few minutes. Type in the business's hours, services, and policies — or paste their website and let CallCatcher fill it in." },
    { question: "Is it really AI answering?", answer: "Yes — it's a natural-sounding voice agent. You're actually talking to one right now." },
    { question: "Can it book appointments?", answer: "Yes. It captures appointment requests and messages, texts the owner right away, and every request lands in your inbox to confirm." },
  ],
  policies:
    "CallCatcher starts with a 14-day free trial — every feature, no credit card. Plans are month to month and you can cancel any time. Phone numbers bill at about a dollar fifteen a month each.",
  notes:
    "This is CallCatcher's own AI receptionist — the caller is talking to the actual product. If they'd like a human or a walkthrough, offer to take a message or book a demo call. Keep it warm and brief. Never invent features or prices beyond what's listed here.",
};

/** In-memory profile for the text demo (no DB row). */
export const DEMO_PROFILE: BusinessProfile = {
  id: "biz_demo",
  tenantId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...DEMO_BUSINESS_INPUT,
};

export const DEMO_SYSTEM_PROMPT = buildSystemPrompt(DEMO_PROFILE, { personality: "friendly", tools: ALL_TOOLS });
export const DEMO_GREETING = buildGreeting(DEMO_PROFILE, "friendly");

/** Simulated tools for the *text* demo — same shape as the real ones, but
 *  nothing is persisted (the text demo has no DB business). */
export async function executeDemoTool(call: { name: string; input?: Record<string, unknown> }) {
  const input = call.input ?? {};
  const str = (k: string) => {
    const v = input[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  switch (call.name) {
    case "take_message":
      return {
        result: "Message saved. Confirm to the caller that the team will get back to them.",
        summary: `📝 Took a message from ${str("caller_name") ?? "caller"}${str("callback_number") ? ` (${str("callback_number")})` : ""}: "${str("message") ?? ""}"`,
      };
    case "request_appointment":
      return {
        result: "Appointment request saved. Tell the caller the team will confirm the exact time shortly.",
        summary: `📅 Appointment request: ${str("name") ?? "caller"} — ${str("service") ?? "service TBD"} — ${str("preferred_times") ?? "time TBD"}`,
      };
    case "transfer_call":
      return { result: "Transferring the caller now.", action: "transfer" as const, summary: `📞 Transferring caller — ${str("reason") ?? ""}` };
    case "end_call":
      return { result: "Ending the call.", action: "end" as const, summary: `👋 Call ended by assistant${str("reason") ? ` — ${str("reason")}` : ""}` };
    default:
      return { result: `Unknown tool: ${call.name}`, isError: true, summary: `⚠️ Unknown tool ${call.name}` };
  }
}

let cachedDemoBusinessId: string | undefined;

/** Idempotently ensure the demo tenant + business + active receptionist exist,
 *  returning the business id. Called lazily the first time a voice-demo token is
 *  minted, so the DB row exists before the media-stream connects. */
export function ensureDemoSeed(): string {
  if (cachedDemoBusinessId && businesses.get(cachedDemoBusinessId)) return cachedDemoBusinessId;

  if (!tenants.get(DEMO_TENANT_ID)) {
    tenants.create({ id: DEMO_TENANT_ID, name: "CallCatcher Demo", plan: "dev" });
  }

  const existing = businesses
    .list({ tenantId: DEMO_TENANT_ID, includeOrphans: false })
    .find((b) => b.name === DEMO_BUSINESS_INPUT.name);
  const biz = existing ?? businesses.create(DEMO_BUSINESS_INPUT, DEMO_TENANT_ID);

  // Build the receptionist config against the server's *current* providers, and
  // (re)create it whenever the active one is missing or stale. Without this, a
  // receptionist seeded under one provider set (e.g. mock during a test run)
  // would stick even after the server restarts with real keys.
  const defaults = defaultProviders();
  const rcp: Omit<ReceptionistConfig, "id" | "version" | "active" | "createdAt"> = {
    businessId: biz.id,
    systemPrompt: DEMO_SYSTEM_PROMPT,
    greeting: DEMO_GREETING,
    personality: "friendly",
    voice: { provider: defaults.tts, voiceId: defaults.tts === "deepgram" ? "aura-2-thalia-en" : "tone-a" },
    llm: {
      provider: defaults.llm,
      model: defaults.llm === "anthropic" ? config.callModelAnthropic : defaults.llm === "openai" ? config.callModelOpenai : "mock",
      maxTokens: 512,
    },
    sttProvider: defaults.stt,
    tools: ALL_TOOLS,
    maxCallSeconds: DEMO_MAX_CALL_SECONDS,
  };
  const active = receptionists.activeForBusiness(biz.id);
  const stale =
    !active ||
    active.sttProvider !== rcp.sttProvider ||
    active.llm.provider !== rcp.llm.provider ||
    active.voice.provider !== rcp.voice.provider;
  if (stale) receptionists.create(rcp);

  cachedDemoBusinessId = biz.id;
  return biz.id;
}
