/**
 * Twilio subaccount isolation: tenant numbers live in tenant subaccounts,
 * webhooks are signature-checked against the OWNING tenant's subaccount token,
 * and subaccount auth tokens are encrypted at rest (AES-256-GCM, SECRETS_KEY).
 * Twilio's REST API is stubbed at the fetch layer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MASTER_SID = "ACmaster00000000000000000000000000";
const MASTER_TOKEN = "master-auth-token";
const SUB_SID = "ACsub0000000000000000000000000000x";
const SUB_TOKEN = "subaccount-auth-token";
const PUBLIC_URL = "https://catcher.example.com";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-sub-")), "test.sqlite");
process.env.PUBLIC_URL = PUBLIC_URL;
process.env.DASHBOARD_TOKEN = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_JWT_SECRET = "";
process.env.ADMIN_EMAILS = "";
process.env.TWILIO_ACCOUNT_SID = MASTER_SID;
process.env.TWILIO_AUTH_TOKEN = MASTER_TOKEN;
process.env.SECRETS_KEY = randomBytes(32).toString("hex");

let app: any;
let baseUrl = "";
const realFetch = globalThis.fetch;
const twilioRequests: Array<{ url: string; body: string; authSid: string }> = [];

/** Intercept Twilio REST calls; pass everything else through (the test server itself). */
function stubTwilioFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.twilio.com")) return realFetch(input, init);
    const auth = Buffer.from(String(init?.headers?.authorization ?? "").replace("Basic ", ""), "base64").toString();
    twilioRequests.push({ url, body: String(init?.body ?? ""), authSid: auth.split(":")[0] });
    if (url.endsWith("/2010-04-01/Accounts.json")) {
      return new Response(JSON.stringify({ sid: SUB_SID, auth_token: SUB_TOKEN }), { status: 201 });
    }
    if (url.includes("/IncomingPhoneNumbers.json")) {
      return new Response(JSON.stringify({ sid: "PNtest", phone_number: "+15550007777" }), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function twilioSign(url: string, params: Record<string, string>, authToken: string): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

beforeAll(async () => {
  stubTwilioFetch();
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

afterAll(async () => {
  await app?.close();
  globalThis.fetch = realFetch;
});

describe("secret storage", () => {
  it("round-trips and rejects tampering", async () => {
    const { encryptSecret, decryptSecret } = await import("../src/crypto.ts");
    const ct = encryptSecret("hunter2");
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct).not.toContain("hunter2");
    expect(decryptSecret(ct)).toBe("hunter2");
    const parts = ct.split(":");
    parts[3] = parts[3].replace(/^../, "00");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("subaccount lifecycle", () => {
  it("creates + stores an encrypted subaccount for paying tenants, skips dev tenants", async () => {
    const { tenants } = await import("../src/db.ts");
    const { ensureTenantSubaccount, tenantTwilio } = await import("../src/telephony/twilio.ts");

    const dev = tenants.create({ name: "Platform", plan: "dev" });
    expect((await ensureTenantSubaccount(dev)).twilioSubaccountSid).toBeUndefined();
    // Dev tenants fall back to the master account.
    expect(tenantTwilio(dev)!.accountSid).toBe(MASTER_SID);

    const paying = tenants.create({ name: "Acme Answering", plan: "trial" });
    const after = await ensureTenantSubaccount(paying);
    expect(after.twilioSubaccountSid).toBe(SUB_SID);
    expect(after.twilioSubaccountTokenEnc).toBeTruthy();
    expect(after.twilioSubaccountTokenEnc).not.toContain(SUB_TOKEN); // encrypted at rest
    expect(tenantTwilio(after)!.accountSid).toBe(SUB_SID);

    // Idempotent.
    const again = await ensureTenantSubaccount(after);
    expect(again.twilioSubaccountSid).toBe(SUB_SID);
  });

  it("purchases numbers inside the tenant's subaccount", async () => {
    const { tenants } = await import("../src/db.ts");
    const { ensureTenantSubaccount, tenantTwilio } = await import("../src/telephony/twilio.ts");
    const t = await ensureTenantSubaccount(tenants.create({ name: "Buyer Co", plan: "trial" }));
    twilioRequests.length = 0;
    await tenantTwilio(t)!.purchaseNumber("+15550007777");
    const buy = twilioRequests.find((r) => r.url.includes("/IncomingPhoneNumbers.json"));
    expect(buy).toBeTruthy();
    expect(buy!.url).toContain(`/Accounts/${SUB_SID}/`);
    expect(buy!.authSid).toBe(SUB_SID); // authed AS the subaccount, not the master
  });
});

describe("per-tenant webhook signatures", () => {
  let subTenantId = "";
  const SUB_NUMBER = "+15550001111";
  const MASTER_NUMBER = "+15550002222";

  beforeAll(async () => {
    const { tenants, businesses, phoneNumbers, receptionists } = await import("../src/db.ts");
    const { ensureTenantSubaccount } = await import("../src/telephony/twilio.ts");
    const { defaultHours } = await import("../src/types.ts");
    const mkBiz = (tenantId: string | null, name: string) =>
      businesses.create(
        { name, industry: "", description: "", timezone: "UTC", hours: defaultHours(), services: [], faqs: [], policies: "", notes: "" },
        tenantId
      );

    const subTenant = await ensureTenantSubaccount(tenants.create({ name: "Sub Co", plan: "trial" }));
    subTenantId = subTenant.id;
    const b1 = mkBiz(subTenant.id, "Sub Biz");
    phoneNumbers.upsert({ businessId: b1.id, e164: SUB_NUMBER, twilioSid: "PN1", status: "active" });
    receptionists.create({
      businessId: b1.id, systemPrompt: "You are a receptionist.", greeting: "Hello!", personality: "friendly",
      voice: { provider: "mock", voiceId: "tone-a" }, llm: { provider: "mock", model: "mock", maxTokens: 256 },
      sttProvider: "mock", tools: [], maxCallSeconds: 600,
    });

    const legacy = mkBiz(null, "Legacy Biz"); // pre-SaaS row on the master account
    phoneNumbers.upsert({ businessId: legacy.id, e164: MASTER_NUMBER, twilioSid: "PN2", status: "active" });
  });

  const post = (params: Record<string, string>, token?: string) =>
    realFetch(`${baseUrl}/twilio/voice`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(token ? { "x-twilio-signature": twilioSign(`${PUBLIC_URL}/twilio/voice`, params, token) } : {}),
      },
      body: new URLSearchParams(params).toString(),
    });

  it("accepts calls to a subaccount number signed with the SUBACCOUNT token", async () => {
    const res = await post({ To: SUB_NUMBER, From: "+15550009000", CallSid: "CA1" }, SUB_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Connect>"); // real receptionist answered
  });

  it("rejects calls to a subaccount number signed with the MASTER token (and unsigned)", async () => {
    expect((await post({ To: SUB_NUMBER, From: "+15550009000", CallSid: "CA2" }, MASTER_TOKEN)).status).toBe(403);
    expect((await post({ To: SUB_NUMBER, From: "+15550009000", CallSid: "CA3" })).status).toBe(403);
  });

  it("validates master-account numbers (legacy) with the master token", async () => {
    expect((await post({ To: MASTER_NUMBER, From: "+15550009000", CallSid: "CA4" }, MASTER_TOKEN)).status).toBe(200);
    expect((await post({ To: MASTER_NUMBER, From: "+15550009000", CallSid: "CA5" }, SUB_TOKEN)).status).toBe(403);
  });

  it("validates unknown numbers with the master token (polite hangup)", async () => {
    const res = await post({ To: "+15550009999", From: "+15550009000", CallSid: "CA6" }, MASTER_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not configured");
  });

  it("keeps tenants' twilio clients isolated", async () => {
    const { tenants } = await import("../src/db.ts");
    const { tenantTwilio } = await import("../src/telephony/twilio.ts");
    expect(tenantTwilio(tenants.get(subTenantId))!.accountSid).toBe(SUB_SID);
    expect(tenantTwilio(undefined)!.accountSid).toBe(MASTER_SID);
  });
});
