/**
 * Platform-admin APIs: the tenants roster and the suspend/reactivate kill
 * switch. Also asserts the 404 (not 403) gate that hides the surface from
 * ordinary tenants, and that suspension actually flips a tenant inactive.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JWT_SECRET = "admin-test-secret-0123456789abcdef";
const ADMIN_EMAIL = "boss@platform.dev";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-admin-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.DASHBOARD_TOKEN = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;

let app: any;
let baseUrl = "";
let adminToken = "";
let tenantToken = "";
let tenantId = "";

async function mintJwt(sub: string, email: string, agency: string): Promise<string> {
  return new SignJWT({ email, aud: "authenticated", user_metadata: { agency_name: agency } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function call(token: string, pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
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

  adminToken = await mintJwt("user-admin", ADMIN_EMAIL, "Platform HQ");
  tenantToken = await mintJwt("user-tenant", "owner@acme.dev", "Acme Answering");
  // Touch /api/status as each so both users/tenants are bootstrapped.
  await call(adminToken, "/api/status");
  const t = await call(tenantToken, "/api/status");
  tenantId = t.body.auth.tenantId;
});

afterAll(async () => {
  await app?.close();
});

describe("admin gate", () => {
  it("hides the admin surface from ordinary tenants with a 404", async () => {
    expect((await call(tenantToken, "/api/admin/tenants")).status).toBe(404);
    expect((await call(tenantToken, `/api/admin/tenants/${tenantId}/suspend`, { method: "POST" })).status).toBe(404);
    expect((await call(tenantToken, `/api/admin/tenants/${tenantId}/reactivate`, { method: "POST" })).status).toBe(404);
  });

  it("still marks the tenant active — a rejected admin call must not mutate", async () => {
    const s = await call(tenantToken, "/api/status");
    expect(s.body.auth.usage.active).toBe(true);
  });
});

describe("tenants roster", () => {
  it("lists every tenant with plan, usage, and business count", async () => {
    const res = await call(adminToken, "/api/admin/tenants");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const acme = res.body.find((t: any) => t.id === tenantId);
    expect(acme).toBeTruthy();
    expect(acme.name).toBe("Acme Answering");
    expect(acme.plan).toBe("trial");
    expect(acme).toHaveProperty("businesses");
    expect(acme).toHaveProperty("month");
    expect(acme.usage).toHaveProperty("active");
    // The admin's own tenant (plan "dev") is in the roster too.
    expect(res.body.some((t: any) => t.plan === "dev")).toBe(true);
  });
});

describe("suspend / reactivate", () => {
  it("suspending a tenant flips it inactive with a suspended reason", async () => {
    const r = await call(adminToken, `/api/admin/tenants/${tenantId}/suspend`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.tenant.planStatus).toBe("suspended");

    // The suspended tenant now reads inactive and is blocked from creating.
    const s = await call(tenantToken, "/api/status");
    expect(s.body.auth.usage.active).toBe(false);
    expect(s.body.auth.usage.blockedReason).toBe("suspended");
    expect((await call(tenantToken, "/api/businesses", { method: "POST", body: JSON.stringify({ name: "Nope" }) })).status).toBe(402);
  });

  it("reactivating restores access immediately", async () => {
    const r = await call(adminToken, `/api/admin/tenants/${tenantId}/reactivate`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.tenant.planStatus).toBe("active");

    const s = await call(tenantToken, "/api/status");
    expect(s.body.auth.usage.active).toBe(true);
    expect((await call(tenantToken, "/api/businesses", { method: "POST", body: JSON.stringify({ name: "Now Allowed" }) })).status).toBe(200);
  });

  it("404s suspend/reactivate for an unknown tenant id", async () => {
    expect((await call(adminToken, "/api/admin/tenants/tnt_missing/suspend", { method: "POST" })).status).toBe(404);
    expect((await call(adminToken, "/api/admin/tenants/tnt_missing/reactivate", { method: "POST" })).status).toBe(404);
  });
});
