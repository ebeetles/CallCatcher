/**
 * Google Calendar integration: signed connect-link state, tool gating by
 * connection status, the mock calendar client, direct booking through
 * executeTool, and the connect/status/disconnect + public OAuth callback routes.
 * Runs in open + mock-provider mode, so no real Google app is required.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-cal-")), "test.sqlite");
process.env.PUBLIC_URL = "https://cc.test";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_JWT_SECRET = "";
process.env.DASHBOARD_TOKEN = "";
// No GOOGLE_* keys → the calendar client runs in mock mode.

let app: any;
let baseUrl = "";
let businessId = "";

const fetchJson = async (pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const res = await fetch(baseUrl + pathname, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const seeded = await fetchJson("/api/seed-demo", { method: "POST" });
  businessId = seeded.body.id;
  expect(businessId).toBeTruthy();
});

afterAll(async () => {
  await app?.close();
});

describe("signed connect-link state", () => {
  it("round-trips a businessId and rejects tampering/expiry/wrong signature", async () => {
    const { signState, verifyState } = await import("../src/security.ts");
    const token = signState("biz_abc123");
    expect(verifyState(token)).toBe("biz_abc123");
    expect(verifyState(token + "x")).toBeUndefined(); // tampered signature
    expect(verifyState("garbage")).toBeUndefined();
    expect(verifyState(undefined)).toBeUndefined();
    expect(verifyState(signState("biz_x", -1000))).toBeUndefined(); // already expired
  });
});

describe("tool gating by calendar connection", () => {
  it("swaps request_appointment for live booking tools when connected", async () => {
    const { businesses, calendarIntegrations } = await import("../src/db.ts");
    const { toolDefsFor } = await import("../src/agent/tools.ts");
    const biz = businesses.get(businessId)!;

    let names = toolDefsFor(["take_message", "request_appointment"], biz).map((t) => t.name);
    expect(names).toContain("request_appointment");
    expect(names).not.toContain("book_appointment");

    calendarIntegrations.upsert({ businessId, refreshTokenEnc: "mock-refresh-token", accountEmail: "o@x.test" });
    names = toolDefsFor(["take_message", "request_appointment"], biz).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["check_availability", "book_appointment", "take_message"]));
    expect(names).not.toContain("request_appointment");

    calendarIntegrations.remove(businessId);
    names = toolDefsFor(["request_appointment"], biz).map((t) => t.name);
    expect(names).toContain("request_appointment");
  });
});

describe("booking through executeTool (mock calendar)", () => {
  it("check_availability reports open and book_appointment writes a confirmed appointment", async () => {
    const { businesses, calendarIntegrations, appointments } = await import("../src/db.ts");
    const { executeTool } = await import("../src/agent/tools.ts");
    const biz = businesses.get(businessId)!;
    calendarIntegrations.upsert({ businessId, refreshTokenEnc: "mock-refresh-token" });

    const avail = await executeTool(
      { id: "t1", name: "check_availability", input: { start: "2026-08-04T14:00:00", service: "Consultation" } },
      { business: biz, notify: false }
    );
    expect(avail.isError).toBeFalsy();
    expect(avail.result).toMatch(/OPEN/);

    const before = appointments.listForBusiness(businessId).length;
    const booked = await executeTool(
      { id: "t2", name: "book_appointment", input: { name: "Sam Rivera", phone: "5551234567", service: "Consultation", start: "2026-08-04T14:00:00" } },
      { business: biz, notify: false }
    );
    expect(booked.isError).toBeFalsy();
    expect(booked.result).toMatch(/[Bb]ooked/);
    const list = appointments.listForBusiness(businessId);
    expect(list.length).toBe(before + 1);
    expect(list[0].status).toBe("confirmed");

    calendarIntegrations.remove(businessId);
  });
});

describe("connect / status / disconnect routes", () => {
  it("connects instantly in mock mode, reports status, and disconnects", async () => {
    const connect = await fetchJson(`/api/businesses/${businessId}/integrations/google/connect`, { method: "POST", body: "{}" });
    expect(connect.status).toBe(200);
    expect(connect.body.connected).toBe(true);
    expect(connect.body.mock).toBe(true);

    const status = await fetchJson(`/api/businesses/${businessId}/integrations/google`);
    expect(status.body.connected).toBe(true);

    const gone = await fetchJson(`/api/businesses/${businessId}/integrations/google`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    const after = await fetchJson(`/api/businesses/${businessId}/integrations/google`);
    expect(after.body.connected).toBe(false);
  });

  it("404s for an unknown business", async () => {
    const r = await fetchJson(`/api/businesses/biz_does_not_exist/integrations/google`);
    expect(r.status).toBe(404);
  });
});

describe("public OAuth callback", () => {
  it("connects on a valid signed state and rejects a bad one", async () => {
    const { signState } = await import("../src/security.ts");
    const { calendarIntegrations } = await import("../src/db.ts");

    const ok = await fetch(`${baseUrl}/api/integrations/google/callback?code=mock&state=${encodeURIComponent(signState(businessId))}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/connected/i);
    expect(calendarIntegrations.connected(businessId)).toBeTruthy();
    calendarIntegrations.remove(businessId);

    const bad = await fetch(`${baseUrl}/api/integrations/google/callback?code=mock&state=tampered.sig`);
    expect(await bad.text()).toMatch(/invalid|expired/i);
    expect(calendarIntegrations.connected(businessId)).toBeFalsy();
  });
});
