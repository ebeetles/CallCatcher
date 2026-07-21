import type { BusinessProfile, ReceptionistConfig } from "./types.ts";
import type { BusinessInput } from "./db.ts";
import { businesses, receptionists, tenants } from "./db.ts";
import { ALL_TOOLS, buildGreeting, buildSystemPrompt } from "./promptFactory.ts";
import { config, defaultProviders } from "./config.ts";

/**
 * The built-in "Sunrise Dental" demo receptionist that powers the public
 * landing-page demo. Two flavors share one profile:
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
  name: "Sunrise Dental Studio",
  industry: "dental clinic",
  description:
    "A friendly neighborhood dental clinic in Pasadena offering general and cosmetic dentistry for the whole family.",
  timezone: "America/Los_Angeles",
  address: "482 Orange Grove Blvd, Pasadena, CA",
  website: "https://sunrisedental.example.com",
  email: "hello@sunrisedental.example.com",
  forwardNumber: "+15555550123",
  notifySms: false,
  hours: {
    mon: { open: true, ranges: [{ start: "08:00", end: "17:00" }] },
    tue: { open: true, ranges: [{ start: "08:00", end: "17:00" }] },
    wed: { open: true, ranges: [{ start: "08:00", end: "17:00" }] },
    thu: { open: true, ranges: [{ start: "08:00", end: "19:00" }] },
    fri: { open: true, ranges: [{ start: "08:00", end: "14:00" }] },
    sat: { open: false, ranges: [] },
    sun: { open: false, ranges: [] },
  },
  services: [
    { name: "New patient exam + X-rays", price: "$95", durationMin: 60 },
    { name: "Teeth cleaning", price: "$120", durationMin: 45 },
    { name: "Teeth whitening", price: "$350", durationMin: 90 },
    { name: "Emergency visit", price: "from $150", durationMin: 30 },
  ],
  faqs: [
    { question: "Do you take insurance?", answer: "Yes — we accept most PPO plans including Delta Dental, Cigna, and MetLife. We don't accept HMO plans." },
    { question: "Is parking available?", answer: "Yes, free parking is available in the lot behind the building." },
    { question: "Do you see kids?", answer: "Yes, we see patients ages 5 and up." },
  ],
  policies:
    "24-hour cancellation notice required or a $50 fee applies. New patients should arrive 15 minutes early. We accept cash, all major credit cards, and CareCredit.",
  notes: "Dr. Maya Chen and Dr. Robert Alvarez are the dentists. Emergencies are usually seen same-day.",
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
