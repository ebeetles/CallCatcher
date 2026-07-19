/**
 * Plan limits, usage metering, and enforcement: business caps (402), trial
 * expiry lockout, minute-cap call blocking at the voice webhook, and the
 * usage rollup fed by call completion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JWT_SECRET = "plans-test-secret-0123456789abcdef";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-plans-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.DASHBOARD_TOKEN = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
process.env.ADMIN_EMAILS = "";

let app: any;
let baseUrl = "";
let token = "";
let tenantId = "";
let bizId = "";

async function mintJwt(sub: string, email: string): Promise<string> {
  return new SignJWT({ email, aud: "authenticated", user_metadata: { agency_name: "Cap Test Co" } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp({ sessionTimers: { silencePromptMs: 60000, silenceHangupMs: 60000, playbackGraceMs: 500 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  token = await mintJwt("user-cap", "cap@test.dev");
  const status = await api("/api/status");
  tenantId = status.body.auth.tenantId;
});

afterAll(async () => {
  await app?.close();
});

describe("plan catalog", () => {
  it("public config lists purchasable tiers with limits", async () => {
    const cfg = (await fetch(`${baseUrl}/api/public/config`).then((r) => r.json())) as any;
    const ids = cfg.plans.map((p: any) => p.id);
    expect(ids).toEqual(["starter", "pro", "scale"]);
    const pro = cfg.plans.find((p: any) => p.id === "pro");
    expect(pro.maxBusinesses).toBe(5);
    expect(pro.includedMinutes).toBe(1500);
    expect(pro.priceUsd).toBeGreaterThan(0);
  });
});

describe("business cap (trial = 1)", () => {
  it("allows the first business, 402s the second with an upgrade hint", async () => {
    const first = await api("/api/seed-demo", { method: "POST" });
    expect(first.status).toBe(200);
    bizId = first.body.id;

    const second = await api("/api/businesses", {
      method: "POST",
      body: JSON.stringify({ name: "Second Shop" }),
    });
    expect(second.status).toBe(402);
    expect(second.body.code).toBe("plan_limit");
    expect(String(second.body.error)).toContain("Upgrade");
  });
});

describe("usage metering", () => {
  it("rolls call durations into the tenant's month and reports them", async () => {
    const { calls, usage } = await import("../src/db.ts");
    const call = calls.create(bizId, "phone", "CAmetered", "+15550001111");
    calls.end(call.id, "caller-hangup", {
      turns: 3, interruptions: 0, llmInputTokens: 100, llmOutputTokens: 50,
      llmCacheReadTokens: 0, ttsChars: 200, sttSeconds: 10, estimatedCostUsd: 0.12,
    });
    // Duration rounds to ~0s in-test, so also record a real chunk directly.
    usage.record(tenantId, 240, 0.5);

    const u = await api("/api/usage");
    expect(u.status).toBe(200);
    expect(u.body.totals.calls).toBeGreaterThanOrEqual(2);
    expect(u.body.totals.minutes).toBeGreaterThanOrEqual(4);
    expect(u.body.plan.includedMinutes).toBe(60); // trial
    const per = u.body.perBusiness.find((b: any) => b.businessId === bizId);
    expect(per.calls).toBeGreaterThanOrEqual(1);

    const s = await api("/api/status");
    expect(s.body.auth.usage.minutesUsed).toBeGreaterThanOrEqual(4);
    expect(s.body.auth.usage.active).toBe(true);
  });

  it("blocks inbound calls once included minutes are exhausted (webhook TwiML)", async () => {
    const { usage, phoneNumbers } = await import("../src/db.ts");
    phoneNumbers.upsert({ businessId: bizId, e164: "+15550002222", twilioSid: "PNx", status: "active" });
    usage.record(tenantId, 60 * 60, 5); // blow past the 60-minute trial cap

    const res = await fetch(`${baseUrl}/twilio/voice`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: "+15550002222", From: "+15550009000", CallSid: "CAover" }).toString(),
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("temporarily unavailable");
    expect(xml).not.toContain("<Connect>");

    // Test chat keeps working while merely over minutes (plan still active).
    const chat = await api(`/api/businesses/${bizId}/chat`, {
      method: "POST",
      body: JSON.stringify({ history: [{ role: "user", text: "hi" }] }),
    });
    expect(chat.status).toBe(200);
  });
});

describe("trial expiry lockout", () => {
  it("expired trials: creation, chat, stream tokens 402; calls get unavailable TwiML; dashboard reads stay up", async () => {
    const { tenants } = await import("../src/db.ts");
    tenants.update(tenantId, { trialEndsAt: new Date(Date.now() - 86400_000).toISOString() });

    const s = await api("/api/status");
    expect(s.body.auth.usage.active).toBe(false);
    expect(s.body.auth.usage.blockedReason).toBe("trial_expired");

    expect((await api("/api/businesses", { method: "POST", body: JSON.stringify({ name: "Nope" }) })).status).toBe(402);
    const chat = await api(`/api/businesses/${bizId}/chat`, {
      method: "POST",
      body: JSON.stringify({ history: [{ role: "user", text: "hi" }] }),
    });
    expect(chat.status).toBe(402);
    expect((await api(`/api/businesses/${bizId}/stream-token`, { method: "POST" })).status).toBe(402);

    const res = await fetch(`${baseUrl}/twilio/voice`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: "+15550002222", From: "+15550009000", CallSid: "CAtrial" }).toString(),
    });
    expect(await res.text()).toContain("temporarily unavailable");

    // Reads still work — their data isn't hostage.
    expect((await api("/api/businesses")).status).toBe(200);
    expect((await api(`/api/businesses/${bizId}/calls`)).status).toBe(200);
    expect((await api("/api/usage")).status).toBe(200);
  });

  it("upgrading (plan change) unlocks immediately", async () => {
    const { tenants } = await import("../src/db.ts");
    tenants.update(tenantId, { plan: "pro", planStatus: "active" });
    const s = await api("/api/status");
    expect(s.body.auth.usage.active).toBe(true);
    expect((await api("/api/businesses", { method: "POST", body: JSON.stringify({ name: "Second Shop" }) })).status).toBe(200);
  });
});
