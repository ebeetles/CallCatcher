import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { appointments, businesses, calendarIntegrations, calls, messages, phoneNumbers, receptionists, turns } from "../db.ts";
import type { BusinessInput, TenantScope } from "../db.ts";
import { signState, verifyState } from "../security.ts";
import {
  authUrl as googleAuthUrl,
  clearAccessCache as clearGoogleAccessCache,
  exchangeCode as exchangeGoogleCode,
  isMock as gcalMock,
  revoke as revokeGoogle,
  saveConnection,
} from "../integrations/googleCalendar.ts";
import { googleRedirectUri } from "../config.ts";
import { defaultHours } from "../types.ts";
import {
  DEMO_GREETING,
  DEMO_PROFILE,
  DEMO_SYSTEM_PROMPT,
  ensureDemoSeed,
  executeDemoTool,
} from "../demo.ts";
import { ALL_TOOLS, buildGreeting, buildSystemPrompt } from "../promptFactory.ts";
import { authMode, config, defaultProviders, providerStatus } from "../config.ts";
import { getLlm, listVoices } from "../providers/registry.ts";
import { runAgentTurn } from "../agent/agentLoop.ts";
import { calendarLive, executeTool, toolDefsFor } from "../agent/tools.ts";
import { LIVE_SCHEDULING_INSTRUCTIONS, resolveSystemPrompt } from "../promptFactory.ts";
import { estimateMonthly, PRICING } from "../costs.ts";
import * as twilio from "../telephony/twilio.ts";
import { extractFromWebsite, factoryAiAvailable, refinePrompt } from "../ai/factory.ts";
import type { HistoryItem } from "../providers/types.ts";
import { mintStreamToken } from "../security.ts";
import { currentMonth, usage } from "../db.ts";
import { entitlements, entitlementSummary, PLANS, PUBLIC_PLAN_IDS } from "../plans.ts";
import { billingEnabled } from "../billing/stripe.ts";

// Guardrails on public voice-demo starts, protecting the provider budget.
// Two layers: a global ceiling (distributed abuse) and a per-IP window (one
// visitor sitting on "Talk again"). Each demo call is separately capped at 60s
// server-side. Real client IP is read from the tunnel headers when present.
const DEMO_VOICE_MAX_PER_MIN = 20; // global
const DEMO_VOICE_PER_IP_MAX = 3; // per IP...
const DEMO_VOICE_PER_IP_WINDOW_MS = 10 * 60_000; // ...per 10 minutes

let demoVoiceWindowStart = 0;
let demoVoiceCount = 0;
function allowDemoVoiceGlobal(): boolean {
  const now = Date.now();
  if (now - demoVoiceWindowStart > 60_000) {
    demoVoiceWindowStart = now;
    demoVoiceCount = 0;
  }
  if (demoVoiceCount >= DEMO_VOICE_MAX_PER_MIN) return false;
  demoVoiceCount++;
  return true;
}

const demoVoiceByIp = new Map<string, number[]>();
function clientIp(req: FastifyRequest): string {
  return (
    (req.headers["cf-connecting-ip"] as string) ||
    ((req.headers["x-forwarded-for"] as string) ?? "").split(",")[0].trim() ||
    req.ip
  );
}
function allowDemoVoiceForIp(ip: string): boolean {
  const now = Date.now();
  const hits = (demoVoiceByIp.get(ip) ?? []).filter((t) => now - t < DEMO_VOICE_PER_IP_WINDOW_MS);
  if (hits.length >= DEMO_VOICE_PER_IP_MAX) {
    demoVoiceByIp.set(ip, hits);
    return false;
  }
  hits.push(now);
  demoVoiceByIp.set(ip, hits);
  return true;
}

/** Tenant visibility of the authenticated request (auth hook guarantees req.auth). */
function scopeOf(req: FastifyRequest): TenantScope {
  const auth = req.auth!;
  return { tenantId: auth.tenant.id, includeOrphans: auth.platformAdmin };
}

/** Load a business only if the requester's tenant may see it (404 otherwise — never leak existence). */
function scopedBusiness(req: FastifyRequest, id: string) {
  return businesses.getScoped(id, scopeOf(req));
}

const BLOCKED_COPY: Record<string, string> = {
  trial_expired: "Your free trial has ended. Pick a plan to keep your receptionists answering.",
  canceled: "Your subscription is canceled. Pick a plan to reactivate your receptionists.",
  suspended: "This account is suspended. Contact support.",
  past_due: "Your last payment failed. Update your billing details to keep service running.",
};

/** 402 when the tenant's plan is inactive. Returns the entitlements otherwise. */
function requireActivePlan(req: FastifyRequest, reply: any) {
  const ent = entitlements(req.auth!.tenant);
  if (!ent.active) {
    reply.code(402).send({
      error: BLOCKED_COPY[ent.blockedReason ?? ""] ?? "Your plan is inactive.",
      code: "plan_inactive",
      blockedReason: ent.blockedReason,
    });
    return undefined;
  }
  return ent;
}

const HoursSchema = z.record(
  z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  z.object({
    open: z.boolean(),
    ranges: z.array(z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })),
  })
);

const BusinessSchema = z.object({
  name: z.string().min(1).max(120),
  industry: z.string().max(120).default(""),
  description: z.string().max(2000).default(""),
  timezone: z.string().min(1).default("America/Los_Angeles"),
  address: z.string().max(300).optional(),
  website: z.string().max(300).optional(),
  email: z.string().max(200).optional(),
  forwardNumber: z.string().max(30).optional(),
  notifySms: z.boolean().default(true),
  notifyNumber: z.string().max(30).optional(),
  hours: HoursSchema.optional(),
  services: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        price: z.string().optional(),
        durationMin: z.number().int().positive().optional(),
      })
    )
    .default([]),
  faqs: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1) })).default([]),
  policies: z.string().max(5000).default(""),
  notes: z.string().max(5000).default(""),
});

const ReceptionistSchema = z.object({
  personality: z.enum(["friendly", "professional", "warm", "efficient"]).default("friendly"),
  bilingual: z.boolean().default(false),
  systemPrompt: z.string().min(1).optional(),
  greeting: z.string().min(1).optional(),
  extraInstructions: z.string().max(4000).optional(),
  voice: z.object({ provider: z.string(), voiceId: z.string() }).optional(),
  llm: z.object({ provider: z.string(), model: z.string(), maxTokens: z.number().int().min(64).max(2048) }).optional(),
  sttProvider: z.string().optional(),
  tools: z.array(z.string()).optional(),
  maxCallSeconds: z.number().int().min(60).max(3600).optional(),
  useAi: z.boolean().default(false),
});

function businessSummary(id: string) {
  const b = businesses.get(id);
  if (!b) return undefined;
  const number = phoneNumbers.forBusiness(id);
  const rcp = receptionists.activeForBusiness(id);
  const stats = calls.statsForBusiness(id);
  return { ...b, number, receptionist: rcp, stats };
}

/** Minimal branded page shown to the CLIENT after they authorize (or fail). */
function calendarResultPage(reply: any, ok: boolean, detail: string): any {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const title = ok ? "Calendar connected" : "Connection failed";
  const body = ok
    ? `<h1>✓ Calendar connected</h1><p>Your Google Calendar is now linked to <strong>${esc(detail)}</strong>. New appointments booked by the receptionist will appear on your calendar automatically.</p><p class="muted">You can close this tab.</p>`
    : `<h1>Couldn't connect</h1><p>${esc(detail)}</p><p class="muted">You can close this tab and ask for a new link.</p>`;
  return reply.send(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf6;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:24px}
.card{max-width:440px;background:#151b2e;border:1px solid #263049;border-radius:16px;padding:32px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;margin:0 0 10px}.muted{color:#8b97b5;font-size:14px}</style></head>
<body><div class="card">${body}</div></body></html>`
  );
}

export function registerApiRoutes(app: FastifyInstance) {
  // ---------- public (no auth; see PUBLIC_API_PATHS in app.ts) ----------
  app.get("/api/health", async () => ({ ok: true }));

  /** Bootstrap config for the web app: auth mode, Supabase coordinates, and plan catalog. */
  app.get("/api/public/config", async () => ({
    authMode: authMode(),
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    billingEnabled: billingEnabled(),
    plans: PUBLIC_PLAN_IDS.map((id) => {
      const p = PLANS[id];
      return {
        id: p.id,
        label: p.label,
        priceUsd: p.priceUsd,
        maxBusinesses: p.maxBusinesses,
        includedMinutes: p.includedMinutes,
        elevenlabs: p.elevenlabs,
        blurb: p.blurb,
      };
    }),
    demo: { name: DEMO_PROFILE.name, greeting: DEMO_GREETING },
  }));

  /** Public, unauthenticated demo chat (see PUBLIC_API_PATHS). Runs a real agent
   *  turn against the built-in demo receptionist with simulated tools. Tightly
   *  rate-limited since it spends the operator's LLM budget. */
  app.post("/api/public/demo-chat", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = (req.body ?? {}) as { history?: Array<{ role: string; text: string }> };
    const history: HistoryItem[] = (body.history ?? [])
      .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
      .map((h) => ({ role: h.role as "user" | "assistant", text: h.text.slice(0, 1000) }))
      .slice(-12); // cap turns fed back to the model
    if (history.length === 0 || history[history.length - 1].role !== "user") {
      return reply.code(400).send({ error: "history must end with a user turn" });
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());

    const defaults = defaultProviders();
    try {
      const result = await runAgentTurn({
        llm: getLlm(defaults.llm),
        model: defaults.llm === "anthropic" ? config.callModelAnthropic : defaults.llm === "openai" ? config.callModelOpenai : "mock",
        maxTokens: 512,
        system: resolveSystemPrompt(DEMO_SYSTEM_PROMPT, DEMO_PROFILE),
        history,
        tools: toolDefsFor(ALL_TOOLS, DEMO_PROFILE),
        signal: ac.signal,
        onTextDelta: (delta) => send({ type: "text", delta }),
        onToolExecuted: (_call, outcome) => send({ type: "tool", summary: outcome.summary }),
        executeTool: (call) => executeDemoTool(call),
      });
      send({ type: "done", endAction: result.endAction, error: result.error, firstTokenMs: result.firstTokenMs });
    } catch (err: any) {
      send({ type: "done", error: String(err?.message ?? err) });
    }
    reply.raw.end();
    return reply;
  });

  /** Public, unauthenticated token for one browser voice-demo call. Mints a
   *  single-use media-stream token bound to the seeded demo business, so the
   *  browser mic can drive the *real* voice pipeline. Guardrails: per-IP rate
   *  limit here + a global ceiling + the demo receptionist's 60s hard cap.
   *  (See PUBLIC_API_PATHS in app.ts.) */
  app.post(
    "/api/public/demo-voice-token",
    {
      config: {
        rateLimit: {
          max: 6,
          timeWindow: "1 minute",
          // Operator's own testing key skips this route limiter too (see below).
          allowList: (req: FastifyRequest) =>
            !!config.demoDevKey && req.headers["x-demo-dev-key"] === config.demoDevKey,
        },
      },
    },
    async (req, reply) => {
      // Same key also bypasses the per-IP/global throttle below (never
      // advertised publicly). The per-call 60s hard cap still applies.
      const isDev = !!config.demoDevKey && req.headers["x-demo-dev-key"] === config.demoDevKey;
      if (!isDev) {
        if (!allowDemoVoiceForIp(clientIp(req))) {
          return reply
            .code(429)
            .send({ error: "You've reached the live-demo limit for now. Start a free trial to keep going." });
        }
        if (!allowDemoVoiceGlobal()) {
          return reply.code(429).send({ error: "The live demo is busy right now — please try again in a moment." });
        }
      }
      const businessId = ensureDemoSeed();
      return { token: mintStreamToken({ businessId, web: true }), expiresInSec: 300 };
    }
  );

  // ---------- meta ----------
  app.get("/api/status", async (req) => {
    const auth = req.auth!;
    return {
      providers: providerStatus(),
      defaults: defaultProviders(),
      publicUrl: config.publicUrl,
      twilioReady: twilio.twilioConfigured(),
      factoryAi: factoryAiAvailable(),
      callModels: {
        anthropic: config.callModelAnthropic,
        openai: config.callModelOpenai,
      },
      pricing: PRICING,
      auth: {
        mode: authMode(),
        email: auth.user.email,
        tenantId: auth.tenant.id,
        tenantName: auth.tenant.name,
        plan: auth.tenant.plan,
        planStatus: auth.tenant.planStatus,
        trialEndsAt: auth.tenant.trialEndsAt,
        platformAdmin: auth.platformAdmin,
        usage: entitlementSummary(auth.tenant),
        billing: {
          enabled: billingEnabled(),
          hasAccount: !!auth.tenant.stripeCustomerId,
          currentPeriodEnd: auth.tenant.currentPeriodEnd,
        },
      },
    };
  });

  // ---------- usage ----------
  app.get("/api/usage", async (req) => {
    const tenant = req.auth!.tenant;
    const ent = entitlements(tenant);
    const month = currentMonth();
    const totals = usage.month(tenant.id);
    return {
      month,
      plan: {
        id: ent.plan.id,
        label: ent.plan.label,
        includedMinutes: ent.plan.includedMinutes === Number.POSITIVE_INFINITY ? null : ent.plan.includedMinutes,
        maxBusinesses: ent.plan.maxBusinesses === Number.POSITIVE_INFINITY ? null : ent.plan.maxBusinesses,
      },
      active: ent.active,
      blockedReason: ent.blockedReason,
      trialDaysLeft: ent.trialDaysLeft,
      totals: {
        calls: totals.calls,
        minutes: Math.round(totals.seconds / 60),
        estCostUsd: Math.round(totals.estCostUsd * 100) / 100,
      },
      perBusiness: usage.perBusinessMonth(tenant.id).map((b) => ({
        businessId: b.businessId,
        name: b.name,
        calls: b.calls,
        minutes: Math.round(b.seconds / 60),
      })),
    };
  });

  app.get("/api/voices", async () => listVoices());

  app.get("/api/costs/estimate", async (req) => {
    const q = req.query as Record<string, string>;
    return estimateMonthly({
      callsPerDay: Number(q.callsPerDay ?? 12),
      avgCallMinutes: Number(q.avgCallMinutes ?? 2.5),
      llmModel: q.llmModel ?? config.callModelAnthropic,
      ttsProvider: q.ttsProvider ?? "deepgram",
    });
  });

  // ---------- businesses ----------
  app.get("/api/businesses", async (req) =>
    businesses.list(scopeOf(req)).map((b) => businessSummary(b.id))
  );

  app.post("/api/businesses", async (req, reply) => {
    const ent = requireActivePlan(req, reply);
    if (!ent) return;
    if (businesses.countForTenant(req.auth!.tenant.id) >= ent.plan.maxBusinesses) {
      return reply.code(402).send({
        error: `Your ${ent.plan.label} plan includes ${ent.plan.maxBusinesses} business${ent.plan.maxBusinesses === 1 ? "" : "es"}. Upgrade to add more.`,
        code: "plan_limit",
      });
    }
    const parsed = BusinessSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const input: BusinessInput = { ...parsed.data, hours: parsed.data.hours ?? defaultHours() } as BusinessInput;
    const biz = businesses.create(input, req.auth!.tenant.id);
    return businessSummary(biz.id);
  });

  app.get("/api/businesses/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    return businessSummary(id);
  });

  app.put("/api/businesses/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    const parsed = BusinessSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    businesses.update(id, parsed.data as Partial<BusinessInput>);
    return businessSummary(id);
  });

  app.delete("/api/businesses/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    businesses.delete(id);
    return { ok: true };
  });

  // ---------- receptionist factory ----------
  app.post("/api/businesses/:id/receptionist/preview", async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    if (!biz) return reply.code(404).send({ error: "business not found" });
    const parsed = ReceptionistSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const p = parsed.data;
    let systemPrompt = buildSystemPrompt(biz, {
      personality: p.personality,
      tools: p.tools ?? ALL_TOOLS,
      extraInstructions: p.extraInstructions,
      bilingual: p.bilingual,
    });
    let aiRefined = false;
    if (p.useAi && factoryAiAvailable()) {
      try {
        systemPrompt = await refinePrompt(biz, systemPrompt);
        aiRefined = true;
      } catch (err: any) {
        app.log?.warn?.(`prompt refinement failed: ${err?.message}`);
      }
    }
    return {
      systemPrompt,
      greeting: p.greeting ?? buildGreeting(biz, p.personality),
      aiRefined,
    };
  });

  app.post("/api/businesses/:id/receptionist", async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    if (!biz) return reply.code(404).send({ error: "business not found" });
    const parsed = ReceptionistSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const p = parsed.data;
    const defaults = defaultProviders();

    let systemPrompt = p.systemPrompt;
    if (!systemPrompt) {
      systemPrompt = buildSystemPrompt(biz, {
        personality: p.personality,
        tools: p.tools ?? ALL_TOOLS,
        extraInstructions: p.extraInstructions,
        bilingual: p.bilingual,
      });
      if (p.useAi && factoryAiAvailable()) {
        try {
          systemPrompt = await refinePrompt(biz, systemPrompt);
        } catch {
          // keep template version
        }
      }
    }

    const llmProvider = p.llm?.provider ?? defaults.llm;
    const rcp = receptionists.create({
      businessId: id,
      systemPrompt,
      greeting: p.greeting ?? buildGreeting(biz, p.personality),
      personality: p.personality,
      bilingual: p.bilingual,
      voice: p.voice ?? { provider: defaults.tts, voiceId: defaults.tts === "deepgram" ? "aura-2-thalia-en" : defaults.tts === "elevenlabs" ? "21m00Tcm4TlvDq8ikWAM" : "tone-a" },
      llm:
        p.llm ??
        {
          provider: llmProvider,
          model: llmProvider === "anthropic" ? config.callModelAnthropic : llmProvider === "openai" ? config.callModelOpenai : "mock",
          maxTokens: 512,
        },
      sttProvider: p.sttProvider ?? defaults.stt,
      tools: p.tools ?? ALL_TOOLS,
      maxCallSeconds: p.maxCallSeconds ?? 600,
    });
    return rcp;
  });

  app.get("/api/businesses/:id/receptionists", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    return receptionists.listForBusiness(id);
  });

  // ---------- web test-dialer stream token ----------
  /** Single-use token authorizing one media-stream connection to this business. */
  app.post("/api/businesses/:id/stream-token", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    if (!requireActivePlan(req, reply)) return;
    return { token: mintStreamToken({ businessId: id, web: true }), expiresInSec: 300 };
  });

  // ---------- website extraction ----------
  // Tight per-route limit: each hit fetches an arbitrary URL and runs an Opus call.
  app.post("/api/extract-website", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string };
    if (!body.url) return reply.code(400).send({ error: "url required" });
    if (!factoryAiAvailable()) {
      return reply.code(501).send({ error: "Website extraction needs ANTHROPIC_API_KEY. Fill the form manually for now." });
    }
    try {
      const data = await extractFromWebsite(body.url);
      return { extracted: data };
    } catch (err: any) {
      return reply.code(422).send({ error: String(err?.message ?? err) });
    }
  });

  // ---------- numbers ----------
  // All number operations go through the tenant's Twilio client: its own
  // subaccount when provisioned, the master account otherwise (dev/legacy).
  app.get("/api/businesses/:id/number/search", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    const client = twilio.tenantTwilio(req.auth!.tenant);
    if (!client) return reply.code(501).send({ error: "Twilio keys not configured" });
    const q = req.query as Record<string, string>;
    try {
      return { numbers: await client.searchNumbers({ areaCode: q.areaCode, contains: q.contains }) };
    } catch (err: any) {
      return reply.code(502).send({ error: String(err?.message ?? err) });
    }
  });

  app.post("/api/businesses/:id/number/provision", async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    if (!biz) return reply.code(404).send({ error: "business not found" });
    if (!twilio.twilioConfigured()) return reply.code(501).send({ error: "Twilio keys not configured" });
    const body = (req.body ?? {}) as { e164?: string };
    if (!body.e164) return reply.code(400).send({ error: "e164 required (pick from /number/search)" });
    try {
      // Lazy retry: if subaccount creation failed at signup, try again now.
      const tenant = await twilio.ensureTenantSubaccount(req.auth!.tenant);
      const client = twilio.tenantTwilio(tenant)!;
      const bought = await client.purchaseNumber(body.e164);
      phoneNumbers.upsert({ businessId: id, e164: bought.e164, twilioSid: bought.sid, status: "active" });
      return { ok: true, number: phoneNumbers.forBusiness(id) };
    } catch (err: any) {
      return reply.code(502).send({ error: String(err?.message ?? err) });
    }
  });

  /** Attach a number you already own (optionally reconfiguring its webhook). */
  app.post("/api/businesses/:id/number/attach", async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    if (!biz) return reply.code(404).send({ error: "business not found" });
    const body = (req.body ?? {}) as { e164?: string; twilioSid?: string };
    if (!body.e164) return reply.code(400).send({ error: "e164 required" });
    // A number maps to exactly one business. Moving it between your own
    // businesses is fine; claiming another tenant's number is not.
    const existing = phoneNumbers.byE164(body.e164);
    if (existing && existing.businessId !== id) {
      if (!businesses.getScoped(existing.businessId, scopeOf(req))) {
        return reply.code(409).send({ error: "That number is already attached to another business." });
      }
      phoneNumbers.delete(existing.businessId);
    }
    const client = twilio.tenantTwilio(req.auth!.tenant);
    if (body.twilioSid && client) {
      try {
        await client.configureNumber(body.twilioSid);
      } catch (err: any) {
        return reply.code(502).send({ error: String(err?.message ?? err) });
      }
    }
    phoneNumbers.upsert({
      businessId: id,
      e164: body.e164,
      twilioSid: body.twilioSid,
      status: body.twilioSid ? "active" : "manual",
    });
    return { ok: true, number: phoneNumbers.forBusiness(id) };
  });

  app.delete("/api/businesses/:id/number", async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    if (!biz) return reply.code(404).send({ error: "business not found" });
    phoneNumbers.delete(id);
    return { ok: true };
  });

  app.get("/api/twilio/owned-numbers", async (req, reply) => {
    const client = twilio.tenantTwilio(req.auth!.tenant);
    if (!client) return reply.code(501).send({ error: "Twilio keys not configured" });
    try {
      return { numbers: await client.listOwnedNumbers() };
    } catch (err: any) {
      return reply.code(502).send({ error: String(err?.message ?? err) });
    }
  });

  // ---------- calls / transcripts ----------
  app.get("/api/businesses/:id/calls", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    return calls.listForBusiness(id);
  });

  app.get("/api/calls/:callId", async (req, reply) => {
    const { callId } = req.params as { callId: string };
    const call = calls.getScoped(callId, scopeOf(req));
    if (!call) return reply.code(404).send({ error: "not found" });
    return { call, turns: turns.forCall(callId) };
  });

  // ---------- messages / appointments ----------
  app.get("/api/businesses/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    return messages.listForBusiness(id);
  });
  app.patch("/api/messages/:msgId", async (req, reply) => {
    const { msgId } = req.params as { msgId: string };
    if (!messages.isScoped(msgId, scopeOf(req))) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as { status?: "new" | "handled" };
    if (body.status) messages.setStatus(msgId, body.status);
    return { ok: true };
  });

  app.get("/api/businesses/:id/appointments", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    return appointments.listForBusiness(id);
  });
  app.patch("/api/appointments/:apptId", async (req, reply) => {
    const { apptId } = req.params as { apptId: string };
    if (!appointments.isScoped(apptId, scopeOf(req))) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as { status?: "new" | "confirmed" | "declined" };
    if (body.status) appointments.setStatus(apptId, body.status);
    return { ok: true };
  });

  // ---------- Google Calendar integration ----------
  // Operator-facing: you set this up for a client. Because reading a client's
  // availability and writing to their calendar needs THEIR Google consent, the
  // primary flow is a signed, shareable link you send them (they click once).
  // "Connect now" opens the same link if you're setting it up together.

  /** Safe public view of a business's calendar connection (never exposes tokens). */
  function calendarStatus(businessId: string) {
    const rec = calendarIntegrations.get(businessId);
    return {
      connected: !!rec && rec.status === "connected",
      provider: "google" as const,
      accountEmail: rec?.accountEmail,
      calendarId: rec?.calendarId ?? "primary",
      /** true = no real Google app configured; bookings are simulated. */
      mock: gcalMock(),
    };
  }

  app.get("/api/businesses/:id/integrations/google", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    return calendarStatus(id);
  });

  // Returns a consent link to hand to the client (real mode), or connects
  // instantly (mock/zero-config, so the demo shows live booking with no keys).
  app.post("/api/businesses/:id/integrations/google/connect", async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    if (!biz) return reply.code(404).send({ error: "not found" });
    if (gcalMock()) {
      saveConnection(biz.id, await exchangeGoogleCode("mock"));
      return { ...calendarStatus(biz.id), connected: true };
    }
    const url = googleAuthUrl(signState(biz.id));
    return { connected: false, url, redirectUri: googleRedirectUri() };
  });

  app.delete("/api/businesses/:id/integrations/google", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!scopedBusiness(req, id)) return reply.code(404).send({ error: "not found" });
    const rec = calendarIntegrations.get(id);
    if (rec) {
      await revokeGoogle(rec.refreshTokenEnc);
      calendarIntegrations.remove(id);
      clearGoogleAccessCache(id);
    }
    return { ok: true };
  });

  // Public: Google redirects the CLIENT's browser here (no dashboard session).
  // Authorization comes from the HMAC-signed `state` minted by connect above.
  app.get("/api/integrations/google/callback", async (req, reply) => {
    const q = (req.query ?? {}) as { code?: string; state?: string; error?: string };
    reply.type("text/html");
    if (q.error) return calendarResultPage(reply, false, `Google reported: ${q.error}`);
    const businessId = verifyState(q.state);
    const biz = businessId ? businesses.get(businessId) : undefined;
    if (!businessId || !q.code || !biz) {
      return calendarResultPage(reply, false, "This connection link is invalid or has expired. Ask for a fresh link.");
    }
    try {
      saveConnection(businessId, await exchangeGoogleCode(q.code));
      return calendarResultPage(reply, true, biz.name);
    } catch (err) {
      return calendarResultPage(reply, false, (err as Error)?.message ?? "Something went wrong connecting the calendar.");
    }
  });

  // ---------- text chat simulator (SSE) ----------
  app.post("/api/businesses/:id/chat", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    const rcp = biz ? receptionists.activeForBusiness(id) : undefined;
    if (!biz || !rcp) return reply.code(404).send({ error: "business or receptionist not found" });
    // Over-minutes tenants may still test-chat (evaluation path); inactive plans may not.
    if (!requireActivePlan(req, reply)) return;

    const body = (req.body ?? {}) as { history?: Array<{ role: string; text: string }> };
    const history: HistoryItem[] = (body.history ?? [])
      .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
      .map((h) => ({ role: h.role as "user" | "assistant", text: h.text }));
    if (history.length === 0 || history[history.length - 1].role !== "user") {
      return reply.code(400).send({ error: "history must end with a user turn" });
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);

    const ac = new AbortController();

    try {
      const result = await runAgentTurn({
        llm: getLlm(rcp.llm.provider),
        model: rcp.llm.model,
        maxTokens: rcp.llm.maxTokens,
        system:
          resolveSystemPrompt(rcp.systemPrompt, biz) +
          (calendarLive(biz) ? "\n\n" + LIVE_SCHEDULING_INSTRUCTIONS : ""),
        history,
        tools: toolDefsFor(rcp.tools, biz),
        signal: ac.signal,
        onTextDelta: (delta) => send({ type: "text", delta }),
        onToolExecuted: (_call, outcome) => send({ type: "tool", summary: outcome.summary }),
        executeTool: (call) => executeTool(call, { business: biz }),
      });
      send({
        type: "done",
        endAction: result.endAction,
        error: result.error,
        usage: result.usage,
        firstTokenMs: result.firstTokenMs,
      });
    } catch (err: any) {
      send({ type: "done", error: String(err?.message ?? err) });
    }
    reply.raw.end();
    return reply;
  });

  // ---------- demo seed ----------
  app.post("/api/seed-demo", async (req, reply) => {
    const existing = businesses.list(scopeOf(req)).find((b) => b.name === "Sunrise Dental Studio");
    if (existing) return businessSummary(existing.id);
    const ent = requireActivePlan(req, reply);
    if (!ent) return;
    if (businesses.countForTenant(req.auth!.tenant.id) >= ent.plan.maxBusinesses) {
      return reply.code(402).send({ error: `Your ${ent.plan.label} plan is at its business limit.`, code: "plan_limit" });
    }
    const biz = businesses.create({
      name: "Sunrise Dental Studio",
      industry: "dental clinic",
      description:
        "A friendly neighborhood dental clinic in Pasadena offering general and cosmetic dentistry for the whole family.",
      timezone: "America/Los_Angeles",
      address: "482 Orange Grove Blvd, Pasadena, CA",
      website: "https://sunrisedental.example.com",
      email: "hello@sunrisedental.example.com",
      forwardNumber: "+15555550123",
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
    }, req.auth!.tenant.id);
    const defaults = defaultProviders();
    receptionists.create({
      businessId: biz.id,
      systemPrompt: buildSystemPrompt(biz, { personality: "friendly", tools: ALL_TOOLS }),
      greeting: buildGreeting(biz, "friendly"),
      personality: "friendly",
      bilingual: false,
      voice: { provider: defaults.tts, voiceId: defaults.tts === "deepgram" ? "aura-2-thalia-en" : "tone-a" },
      llm: {
        provider: defaults.llm,
        model: defaults.llm === "anthropic" ? config.callModelAnthropic : defaults.llm === "openai" ? config.callModelOpenai : "mock",
        maxTokens: 512,
      },
      sttProvider: defaults.stt,
      tools: ALL_TOOLS,
      maxCallSeconds: 600,
    });
    return businessSummary(biz.id);
  });
}
