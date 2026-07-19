import Stripe from "stripe";
import { config } from "../config.ts";
import { tenants } from "../db.ts";
import { PLANS, PUBLIC_PLAN_IDS } from "../plans.ts";
import { setSubaccountStatus, twilioConfigured } from "../telephony/twilio.ts";
import type { TenantRecord } from "../types.ts";

/**
 * Stripe subscriptions. Checkout Session to subscribe, Customer Portal to
 * manage, webhooks to keep tenants.plan/plan_status in sync. Stripe is the
 * source of truth for billing state; SQLite mirrors what enforcement needs.
 */

let client: Stripe | undefined;
export function stripe(): Stripe | undefined {
  if (!config.stripeSecretKey) return undefined;
  client ??= new Stripe(config.stripeSecretKey);
  return client;
}

/** Billing is on when we can create sessions AND verify webhooks. */
export function billingEnabled(): boolean {
  return !!(config.stripeSecretKey && config.stripeWebhookSecret && PUBLIC_PLAN_IDS.some((id) => config.stripePrices[id]));
}

export function planToPrice(planId: string): string | undefined {
  return config.stripePrices[planId] || undefined;
}

export function priceToPlan(priceId: string | undefined): string | undefined {
  if (!priceId) return undefined;
  return Object.entries(config.stripePrices).find(([, pid]) => pid === priceId)?.[0];
}

function billingUrl(outcome: string): string {
  const base = config.appUrl || "http://localhost:5173";
  return `${base}/billing?checkout=${outcome}`;
}

/** Reuse the tenant's Stripe customer or create (and remember) one. */
async function ensureCustomer(s: Stripe, tenant: TenantRecord, email: string): Promise<string> {
  if (tenant.stripeCustomerId) return tenant.stripeCustomerId;
  const customer = await s.customers.create({
    email,
    name: tenant.name,
    metadata: { tenantId: tenant.id },
  });
  tenants.update(tenant.id, { stripeCustomerId: customer.id });
  return customer.id;
}

export async function createCheckoutSession(tenant: TenantRecord, email: string, planId: string): Promise<{ url: string }> {
  const s = stripe();
  const price = planToPrice(planId);
  if (!s || !price) throw new Error(`Billing not configured for plan '${planId}'`);
  const customer = await ensureCustomer(s, tenant, email);
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: tenant.id,
    metadata: { tenantId: tenant.id, plan: planId },
    subscription_data: { metadata: { tenantId: tenant.id, plan: planId } },
    success_url: billingUrl("success"),
    cancel_url: billingUrl("canceled"),
    allow_promotion_codes: true,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}

export async function createPortalSession(tenant: TenantRecord): Promise<{ url: string }> {
  const s = stripe();
  if (!s) throw new Error("Billing not configured");
  if (!tenant.stripeCustomerId) throw new Error("No billing account yet — subscribe to a plan first");
  const session = await s.billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: billingUrl("portal"),
  });
  return { url: session.url };
}

// ---------- webhook sync ----------

function suspendTelephony(tenant: TenantRecord, suspend: boolean): void {
  if (!twilioConfigured() || !tenant.twilioSubaccountSid) return;
  setSubaccountStatus(tenant.twilioSubaccountSid, suspend ? "suspended" : "active")
    .then(() => console.log(`[billing] subaccount ${tenant.twilioSubaccountSid} ${suspend ? "suspended" : "reactivated"}`))
    .catch((err: any) => console.error(`[billing] subaccount status change failed: ${err?.message ?? err}`));
}

function tenantForCustomer(customerId: string | undefined, metaTenantId: string | undefined): TenantRecord | undefined {
  if (metaTenantId) {
    const t = tenants.get(metaTenantId);
    if (t) return t;
  }
  return customerId ? tenants.byStripeCustomer(customerId) : undefined;
}

/** Map a Stripe subscription status to our plan_status. */
function mapStatus(sub: Stripe.Subscription): "active" | "past_due" | "canceled" {
  switch (sub.status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    default:
      // canceled, unpaid, incomplete, incomplete_expired, paused
      return "canceled";
  }
}

function syncSubscription(sub: Stripe.Subscription): void {
  const tenant = tenantForCustomer(
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    sub.metadata?.tenantId
  );
  if (!tenant) {
    console.warn(`[billing] subscription ${sub.id} has no matching tenant`);
    return;
  }
  const wasActive = tenant.planStatus === "active" || tenant.planStatus === "past_due";
  const status = mapStatus(sub);
  const plan = priceToPlan(sub.items?.data?.[0]?.price?.id) ?? tenant.plan;
  const periodEnd = (sub.items?.data?.[0] as any)?.current_period_end ?? (sub as any).current_period_end;
  tenants.update(tenant.id, {
    plan: status === "canceled" ? tenant.plan : plan,
    planStatus: status,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : tenant.stripeCustomerId,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
    trialEndsAt: undefined, // on a real subscription now — trial bookkeeping over
  });
  console.log(`[billing] tenant ${tenant.id} → plan=${plan} status=${status}`);
  const isActive = status === "active" || status === "past_due";
  if (wasActive && !isActive) suspendTelephony(tenants.get(tenant.id)!, true);
  if (!wasActive && isActive) suspendTelephony(tenants.get(tenant.id)!, false);
}

export function handleWebhookEvent(event: Stripe.Event): void {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenant = tenantForCustomer(
        typeof session.customer === "string" ? session.customer : session.customer?.id,
        session.client_reference_id ?? session.metadata?.tenantId ?? undefined
      );
      if (!tenant) {
        console.warn(`[billing] checkout session ${session.id} has no matching tenant`);
        return;
      }
      const plan = session.metadata?.plan && PLANS[session.metadata.plan] ? session.metadata.plan : tenant.plan;
      tenants.update(tenant.id, {
        plan,
        planStatus: "active",
        stripeCustomerId: typeof session.customer === "string" ? session.customer : tenant.stripeCustomerId,
        stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : tenant.stripeSubscriptionId,
        trialEndsAt: undefined,
      });
      console.log(`[billing] tenant ${tenant.id} subscribed to ${plan}`);
      suspendTelephony(tenants.get(tenant.id)!, false);
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      syncSubscription(event.data.object as Stripe.Subscription);
      return;
    default:
      // Unhandled event types are fine — we only subscribe to what we need.
      return;
  }
}

/** Verify + parse a webhook request body. Throws on bad signature. */
export function constructWebhookEvent(rawBody: Buffer, signature: string | undefined): Stripe.Event {
  const s = stripe();
  if (!s || !config.stripeWebhookSecret) throw new Error("Billing not configured");
  return s.webhooks.constructEvent(rawBody, signature ?? "", config.stripeWebhookSecret);
}
