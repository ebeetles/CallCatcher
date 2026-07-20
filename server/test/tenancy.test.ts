/**
 * Multi-tenant isolation: two agencies authenticated via (HS256-minted)
 * Supabase JWTs must never see each other's businesses, calls, messages,
 * appointments, or stream tokens. Also covers tenant bootstrap, the dev/ops
 * contexts, and legacy-data adoption by ADMIN_EMAILS.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SignJWT } from "jose";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JWT_SECRET = "test-supabase-jwt-secret-0123456789abcdef";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-tenancy-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.DASHBOARD_TOKEN = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
process.env.ADMIN_EMAILS = "boss@platform.test";

let app: any;
let baseUrl = "";

async function mintJwt(opts: { sub: string; email: string; agencyName?: string; expired?: boolean }): Promise<string> {
  const jwt = new SignJWT({
    email: opts.email,
    aud: "authenticated",
    user_metadata: opts.agencyName ? { agency_name: opts.agencyName } : {},
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.sub)
    .setIssuedAt(opts.expired ? Math.floor(Date.now() / 1000) - 7200 : undefined);
  if (opts.expired) jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 3600);
  else jwt.setExpirationTime("1h");
  return jwt.sign(new TextEncoder().encode(JWT_SECRET));
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function api(token: string, pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      ...bearer(token),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

let tokenA = "";
let tokenB = "";
let bizA = ""; // business owned by tenant A

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp({ sessionTimers: { silencePromptMs: 60000, silenceHangupMs: 60000, playbackGraceMs: 500 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  tokenA = await mintJwt({ sub: "user-aaa", email: "a@agency-a.test", agencyName: "Agency A" });
  tokenB = await mintJwt({ sub: "user-bbb", email: "b@agency-b.test", agencyName: "Agency B" });
});

afterAll(async () => {
  await app?.close();
});

describe("auth gate (supabase mode)", () => {
  it("401s without a token, with garbage, and with an expired JWT", async () => {
    expect((await fetch(`${baseUrl}/api/businesses`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/businesses`, { headers: bearer("garbage") })).status).toBe(401);
    const expired = await mintJwt({ sub: "user-old", email: "old@x.test", expired: true });
    expect((await fetch(`${baseUrl}/api/businesses`, { headers: bearer(expired) })).status).toBe(401);
  });

  it("serves public endpoints without auth", async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    const cfg = (await fetch(`${baseUrl}/api/public/config`).then((r) => r.json())) as any;
    expect(cfg.authMode).toBe("supabase");
  });

  it("bootstraps user + tenant on first authenticated request", async () => {
    const { status, body } = await api(tokenA, "/api/status");
    expect(status).toBe(200);
    expect(body.auth.email).toBe("a@agency-a.test");
    expect(body.auth.tenantName).toBe("Agency A");
    expect(body.auth.plan).toBe("trial");
    expect(body.auth.platformAdmin).toBe(false);
    expect(body.auth.trialEndsAt).toBeTruthy();
  });
});

describe("tenant isolation", () => {
  it("A creates a business; B cannot see or touch it", async () => {
    const created = await api(tokenA, "/api/seed-demo", { method: "POST" });
    expect(created.status).toBe(200);
    bizA = created.body.id;

    // B's list is empty; A's has one.
    expect(((await api(tokenA, "/api/businesses")).body as any[]).length).toBe(1);
    expect(((await api(tokenB, "/api/businesses")).body as any[]).length).toBe(0);

    // Every direct access from B → 404.
    expect((await api(tokenB, `/api/businesses/${bizA}`)).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}`, { method: "PUT", body: JSON.stringify({ name: "hax" }) })).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}`, { method: "DELETE" })).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/receptionists`)).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/receptionist/preview`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/receptionist`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/calls`)).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/messages`)).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/appointments`)).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/chat`, { method: "POST", body: JSON.stringify({ history: [{ role: "user", text: "hi" }] }) })).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/stream-token`, { method: "POST" })).status).toBe(404);
    expect((await api(tokenB, `/api/businesses/${bizA}/number`, { method: "DELETE" })).status).toBe(404);

    // A untouched.
    expect((await api(tokenA, `/api/businesses/${bizA}`)).status).toBe(200);
  });

  it("blocks attaching a number that belongs to another tenant's business", async () => {
    const { phoneNumbers } = await import("../src/db.ts");
    phoneNumbers.upsert({ businessId: bizA, e164: "+15550004444", status: "manual" });
    const seededB = await api(tokenB, "/api/seed-demo", { method: "POST" });
    const res = await api(tokenB, `/api/businesses/${seededB.body.id}/number/attach`, {
      method: "POST",
      body: JSON.stringify({ e164: "+15550004444" }),
    });
    expect(res.status).toBe(409);
    expect(phoneNumbers.byE164("+15550004444")!.businessId).toBe(bizA); // mapping unchanged
  });

  it("isolates calls, messages, and appointments by owning business", async () => {
    const { calls, messages, appointments } = await import("../src/db.ts");
    const call = calls.create(bizA, "chat");
    const msg = messages.create({ businessId: bizA, content: "call me back", urgency: "normal" });
    const appt = appointments.create({ businessId: bizA, name: "Jamie", preferredTimes: "Friday" });

    expect((await api(tokenB, `/api/calls/${call.id}`)).status).toBe(404);
    expect((await api(tokenA, `/api/calls/${call.id}`)).status).toBe(200);

    expect((await api(tokenB, `/api/messages/${msg.id}`, { method: "PATCH", body: JSON.stringify({ status: "handled" }) })).status).toBe(404);
    expect((await api(tokenA, `/api/messages/${msg.id}`, { method: "PATCH", body: JSON.stringify({ status: "handled" }) })).status).toBe(200);

    expect((await api(tokenB, `/api/appointments/${appt.id}`, { method: "PATCH", body: JSON.stringify({ status: "confirmed" }) })).status).toBe(404);
    expect((await api(tokenA, `/api/appointments/${appt.id}`, { method: "PATCH", body: JSON.stringify({ status: "confirmed" }) })).status).toBe(200);
  });

  it("both tenants can seed their own demo without collision", async () => {
    const seededB = await api(tokenB, "/api/seed-demo", { method: "POST" });
    expect(seededB.status).toBe(200);
    expect(seededB.body.id).not.toBe(bizA);
    expect(((await api(tokenB, "/api/businesses")).body as any[]).length).toBe(1);
    expect(((await api(tokenA, "/api/businesses")).body as any[]).length).toBe(1);
  });
});

describe("stream tokens (supabase mode)", () => {
  function openStream(customParameters: Record<string, string>): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(baseUrl.replace("http", "ws") + "/media-stream");
      let gotTranscript = false;
      ws.on("open", () => {
        ws.send(
          JSON.stringify({ event: "start", start: { streamSid: "MZt", callSid: "CAt", customParameters }, streamSid: "MZt" })
        );
      });
      ws.on("message", (raw) => {
        if (JSON.parse(raw.toString()).event === "transcript") gotTranscript = true;
      });
      ws.on("close", () => resolve(gotTranscript));
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
          resolve(gotTranscript);
        }
      }, 2500);
    });
  }

  it("rejects tokenless web streams when auth is configured", async () => {
    expect(await openStream({ businessId: bizA, web: "1" })).toBe(false);
  });

  it("accepts a stream with a token minted by the owning tenant", async () => {
    const minted = await api(tokenA, `/api/businesses/${bizA}/stream-token`, { method: "POST" });
    expect(minted.status).toBe(200);
    expect(await openStream({ businessId: bizA, web: "1", token: minted.body.token, from: "+15550001234" })).toBe(true);
  });
});

describe("platform admin APIs", () => {
  it("hides /api/admin from regular tenants (404) and serves platform admins", async () => {
    expect((await api(tokenA, "/api/admin/tenants")).status).toBe(404);

    const bossToken = await mintJwt({ sub: "user-admin2", email: "boss@platform.test", agencyName: "HQ2" });
    await api(bossToken, "/api/status"); // bootstrap
    const list = await api(bossToken, "/api/admin/tenants");
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const row = list.body.find((t: any) => t.name === "Agency A");
    expect(row).toBeTruthy();
    expect(row.businesses).toBeGreaterThanOrEqual(1);

    // Suspend flips enforcement immediately; reactivate lifts it.
    expect((await api(bossToken, `/api/admin/tenants/${row.id}/suspend`, { method: "POST", body: "{}" })).status).toBe(200);
    const blocked = await api(tokenA, "/api/status");
    expect(blocked.body.auth.usage.active).toBe(false);
    expect(blocked.body.auth.usage.blockedReason).toBe("suspended");
    expect((await api(tokenA, `/api/businesses/${bizA}/chat`, { method: "POST", body: JSON.stringify({ history: [{ role: "user", text: "hi" }] }) })).status).toBe(402);

    expect((await api(bossToken, `/api/admin/tenants/${row.id}/reactivate`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await api(tokenA, "/api/status")).body.auth.usage.active).toBe(true);

    // Regular tenants can't hit the mutation endpoints either.
    expect((await api(tokenA, `/api/admin/tenants/${row.id}/suspend`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("legacy data adoption", () => {
  it("ADMIN_EMAILS signup adopts NULL-tenant businesses and gets platform admin", async () => {
    const { db, businesses } = await import("../src/db.ts");
    const orphan = businesses.create(
      {
        name: "Legacy Barber Shop",
        industry: "barber",
        description: "pre-SaaS data",
        timezone: "America/Los_Angeles",
        hours: (await import("../src/types.ts")).defaultHours(),
        services: [],
        faqs: [],
        policies: "",
        notes: "",
      },
      null
    );
    expect(orphan.tenantId).toBeNull();

    // Regular tenants can't see the orphan…
    expect((await api(tokenA, `/api/businesses/${orphan.id}`)).status).toBe(404);

    // …but the admin's first sign-in claims it.
    const bossToken = await mintJwt({ sub: "user-boss", email: "boss@platform.test", agencyName: "HQ" });
    const status = await api(bossToken, "/api/status");
    expect(status.body.auth.platformAdmin).toBe(true);
    expect(status.body.auth.plan).toBe("dev");
    const adopted = businesses.get(orphan.id)!;
    expect(adopted.tenantId).toBe(status.body.auth.tenantId);
    expect((await api(bossToken, `/api/businesses/${orphan.id}`)).status).toBe(200);
    // Adoption is permanent — other tenants still locked out.
    expect((await api(tokenB, `/api/businesses/${orphan.id}`)).status).toBe(404);
    void db;
  });
});
