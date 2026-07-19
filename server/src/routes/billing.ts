import type { FastifyInstance } from "fastify";
import {
  billingEnabled,
  constructWebhookEvent,
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  planToPrice,
} from "../billing/stripe.ts";
import { PUBLIC_PLAN_IDS } from "../plans.ts";

export function registerBillingRoutes(app: FastifyInstance) {
  /** Start a subscription checkout for a purchasable plan; returns the Stripe URL. */
  app.post("/api/billing/checkout", async (req, reply) => {
    const { plan } = (req.body ?? {}) as { plan?: string };
    if (!plan || !(PUBLIC_PLAN_IDS as readonly string[]).includes(plan)) {
      return reply.code(400).send({ error: `plan must be one of: ${PUBLIC_PLAN_IDS.join(", ")}` });
    }
    if (!billingEnabled() || !planToPrice(plan)) {
      return reply.code(501).send({ error: "Billing isn't configured on this server yet (Stripe keys/prices missing)." });
    }
    try {
      return await createCheckoutSession(req.auth!.tenant, req.auth!.user.email, plan);
    } catch (err: any) {
      return reply.code(502).send({ error: String(err?.message ?? err) });
    }
  });

  /** Stripe Customer Portal (update card, cancel, invoices). */
  app.post("/api/billing/portal", async (req, reply) => {
    if (!billingEnabled()) return reply.code(501).send({ error: "Billing isn't configured on this server yet." });
    try {
      return await createPortalSession(req.auth!.tenant);
    } catch (err: any) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  /**
   * Stripe webhook. Registered in an encapsulated scope with a raw-body parser
   * because signature verification hashes the exact bytes Stripe sent.
   * Not under /api — the auth hook doesn't apply; the signature IS the auth.
   */
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/stripe/webhook", async (req, reply) => {
      let event;
      try {
        event = constructWebhookEvent(req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
      } catch (err: any) {
        return reply.code(400).send({ error: `invalid webhook: ${String(err?.message ?? err)}` });
      }
      try {
        handleWebhookEvent(event);
      } catch (err: any) {
        // 500 → Stripe retries with backoff.
        return reply.code(500).send({ error: String(err?.message ?? err) });
      }
      return { received: true };
    });
  });
}
