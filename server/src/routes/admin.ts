import type { FastifyInstance, FastifyRequest } from "fastify";
import { businesses, tenants, usage } from "../db.ts";
import { entitlementSummary } from "../plans.ts";
import { setSubaccountStatus, twilioConfigured } from "../telephony/twilio.ts";

/**
 * Platform-admin APIs (ADMIN_EMAILS users, ops token, dev mode). 404 — not
 * 403 — for everyone else, so the surface doesn't advertise itself.
 */

function requireAdmin(req: FastifyRequest, reply: any): boolean {
  if (req.auth?.platformAdmin) return true;
  reply.code(404).send({ error: "not found" });
  return false;
}

export function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/admin/tenants", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return tenants.list().map((t) => ({
      id: t.id,
      name: t.name,
      plan: t.plan,
      planStatus: t.planStatus,
      createdAt: t.createdAt,
      trialEndsAt: t.trialEndsAt,
      currentPeriodEnd: t.currentPeriodEnd,
      twilioSubaccountSid: t.twilioSubaccountSid,
      stripeCustomerId: t.stripeCustomerId,
      businesses: businesses.countForTenant(t.id),
      month: usage.month(t.id),
      usage: entitlementSummary(t),
    }));
  });

  app.post("/api/admin/tenants/:id/suspend", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const tenant = tenants.get(id);
    if (!tenant) return reply.code(404).send({ error: "not found" });
    tenants.update(id, { planStatus: "suspended" });
    if (twilioConfigured() && tenant.twilioSubaccountSid) {
      setSubaccountStatus(tenant.twilioSubaccountSid, "suspended").catch((err: any) =>
        console.error(`[admin] subaccount suspend failed: ${err?.message ?? err}`)
      );
    }
    return { ok: true, tenant: tenants.get(id) };
  });

  app.post("/api/admin/tenants/:id/reactivate", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const tenant = tenants.get(id);
    if (!tenant) return reply.code(404).send({ error: "not found" });
    tenants.update(id, { planStatus: "active" });
    if (twilioConfigured() && tenant.twilioSubaccountSid) {
      setSubaccountStatus(tenant.twilioSubaccountSid, "active").catch((err: any) =>
        console.error(`[admin] subaccount reactivate failed: ${err?.message ?? err}`)
      );
    }
    return { ok: true, tenant: tenants.get(id) };
  });
}
