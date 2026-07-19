import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { appointments, businesses, calls, messages, phoneNumbers, receptionists, turns } from "../db.ts";
import type { BusinessInput, TenantScope } from "../db.ts";
import { defaultHours } from "../types.ts";
import { ALL_TOOLS, buildGreeting, buildSystemPrompt } from "../promptFactory.ts";
import { authMode, config, defaultProviders, providerStatus } from "../config.ts";
import { getLlm, listVoices } from "../providers/registry.ts";
import { runAgentTurn } from "../agent/agentLoop.ts";
import { executeTool, toolDefsFor } from "../agent/tools.ts";
import { resolveSystemPrompt } from "../promptFactory.ts";
import { estimateMonthly, PRICING } from "../costs.ts";
import * as twilio from "../telephony/twilio.ts";
import { extractFromWebsite, factoryAiAvailable, refinePrompt } from "../ai/factory.ts";
import type { HistoryItem } from "../providers/types.ts";
import { mintStreamToken } from "../security.ts";

/** Tenant visibility of the authenticated request (auth hook guarantees req.auth). */
function scopeOf(req: FastifyRequest): TenantScope {
  const auth = req.auth!;
  return { tenantId: auth.tenant.id, includeOrphans: auth.platformAdmin };
}

/** Load a business only if the requester's tenant may see it (404 otherwise — never leak existence). */
function scopedBusiness(req: FastifyRequest, id: string) {
  return businesses.getScoped(id, scopeOf(req));
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

export function registerApiRoutes(app: FastifyInstance) {
  // ---------- public (no auth; see PUBLIC_API_PATHS in app.ts) ----------
  app.get("/api/health", async () => ({ ok: true }));

  /** Bootstrap config for the web app: which auth mode, and how to reach Supabase. */
  app.get("/api/public/config", async () => ({
    authMode: authMode(),
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
  }));

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
      },
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

  // ---------- text chat simulator (SSE) ----------
  app.post("/api/businesses/:id/chat", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const biz = scopedBusiness(req, id);
    const rcp = biz ? receptionists.activeForBusiness(id) : undefined;
    if (!biz || !rcp) return reply.code(404).send({ error: "business or receptionist not found" });

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
        system: resolveSystemPrompt(rcp.systemPrompt, biz),
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
  app.post("/api/seed-demo", async (req) => {
    const existing = businesses.list(scopeOf(req)).find((b) => b.name === "Sunrise Dental Studio");
    if (existing) return businessSummary(existing.id);
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
