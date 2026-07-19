/**
 * Stripe billing: webhook signature verification, plan/status sync from
 * checkout + subscription lifecycle events, and paywall integration. All
 * offline — events are signed locally with stripe's test-header helper.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { SignJWT } from "jose";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JWT_SECRET = "billing-test-secret-0123456789abcd";
const WEBHOOK_SECRET = "whsec_test_secret";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-billing-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.DASHBOARD_TOKEN = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_offline_fake";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_PRICE_STARTER = "price_starter_x";
process.env.STRIPE_PRICE_PRO = "price_pro_x";
process.env.STRIPE_PRICE_SCALE = "price_scale_x";

let app: any;
let baseUrl = "";
let token = "";
let tenantId = "";
const signer = new Stripe("sk_test_offline_fake");

async function postWebhook(event: Record<string, unknown>, opts?: { badSig?: boolean }) {
  const payload = JSON.stringify(event);
  const signature = opts?.badSig
    ? "t=1,v1=bogus"
    : signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return fetch(`${baseUrl}/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
}

const evt = (type: string, object: Record<string, unknown>) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`,
  object: "event",
  type,
  data: { object },
});

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  token = await new SignJWT({ email: "owner@billing.test", aud: "authenticated", user_metadata: { agency_name: "Billing Co" } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-billing")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
  const status = await fetch(`${baseUrl}/api/status`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()) as any;
  tenantId = status.auth.tenantId;
});

afterAll(async () => {
  await app?.close();
});

describe("webhook security", () => {
  it("rejects unsigned and badly-signed events", async () => {
    const e = evt("checkout.session.completed", { id: "cs_x" });
    expect((await postWebhook(e, { badSig: true })).status).toBe(400);
    const unsigned = await fetch(`${baseUrl}/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(e),
    });
    expect(unsigned.status).toBe(400);
  });
});

describe("subscription lifecycle sync", () => {
  it("checkout.session.completed activates the chosen plan and clears the trial", async () => {
    const res = await postWebhook(
      evt("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        customer: "cus_123",
        subscription: "sub_123",
        client_reference_id: tenantId,
        metadata: { tenantId, plan: "pro" },
      })
    );
    expect(res.status).toBe(200);
    const { tenants } = await import("../src/db.ts");
    const t = tenants.get(tenantId)!;
    expect(t.plan).toBe("pro");
    expect(t.planStatus).toBe("active");
    expect(t.stripeCustomerId).toBe("cus_123");
    expect(t.stripeSubscriptionId).toBe("sub_123");
    expect(t.trialEndsAt).toBeUndefined();
  });

  it("subscription.updated remaps plan by price id and tracks past_due", async () => {
    const res = await postWebhook(
      evt("customer.subscription.updated", {
        id: "sub_123",
        object: "subscription",
        customer: "cus_123",
        status: "past_due",
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 20,
        items: { data: [{ price: { id: "price_scale_x" } }] },
        metadata: { tenantId },
      })
    );
    expect(res.status).toBe(200);
    const { tenants } = await import("../src/db.ts");
    const t = tenants.get(tenantId)!;
    expect(t.plan).toBe("scale");
    expect(t.planStatus).toBe("past_due");
    expect(t.currentPeriodEnd).toBeTruthy();

    // past_due still counts as usable (grace while Stripe retries).
    const status = (await fetch(`${baseUrl}/api/status`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())) as any;
    expect(status.auth.usage.active).toBe(true);
  });

  it("subscription.deleted cancels and triggers the paywall", async () => {
    const res = await postWebhook(
      evt("customer.subscription.deleted", {
        id: "sub_123",
        object: "subscription",
        customer: "cus_123",
        status: "canceled",
        items: { data: [{ price: { id: "price_scale_x" } }] },
        metadata: { tenantId },
      })
    );
    expect(res.status).toBe(200);
    const status = (await fetch(`${baseUrl}/api/status`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())) as any;
    expect(status.auth.usage.active).toBe(false);
    expect(status.auth.usage.blockedReason).toBe("canceled");

    // …and checkout is the way back in: bad plan ids rejected, real ones pass validation.
    const bad = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan: "dev" }),
    });
    expect(bad.status).toBe(400);
  });

  it("resolves tenants by stripe customer id when metadata is absent", async () => {
    await postWebhook(
      evt("customer.subscription.updated", {
        id: "sub_123",
        object: "subscription",
        customer: "cus_123",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        items: { data: [{ price: { id: "price_starter_x" } }] },
        metadata: {},
      })
    );
    const { tenants } = await import("../src/db.ts");
    const t = tenants.get(tenantId)!;
    expect(t.plan).toBe("starter");
    expect(t.planStatus).toBe("active");
  });
});
