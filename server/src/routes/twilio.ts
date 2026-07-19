import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.ts";
import { businesses, phoneNumbers, receptionists, tenants } from "../db.ts";
import { escapeXml, tenantAuthToken } from "../telephony/twilio.ts";
import { maskPhone, mintStreamToken, validateTwilioSignature } from "../security.ts";
import type { BusinessProfile, TenantRecord } from "../types.ts";

/** Build the wss:// URL Twilio should stream call audio to. */
function streamUrl(req: { headers: Record<string, any> }): string {
  if (config.publicUrl) {
    return config.publicUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/media-stream";
  }
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] ?? "http") === "https" ? "wss" : "ws";
  return `${proto}://${host}/media-stream`;
}

/** The exact URL Twilio signed: prefer PUBLIC_URL (what we register as the webhook). */
function requestUrl(req: FastifyRequest): string {
  const pathAndQuery = req.raw.url ?? "";
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "") + pathAndQuery;
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "localhost";
  const proto = ((req.headers["x-forwarded-proto"] as string) ?? "http").split(",")[0];
  return `${proto}://${host}${pathAndQuery}`;
}

/** The business + tenant that own the number a webhook is about (its To). */
function resolveCallee(body: Record<string, string>): { business?: BusinessProfile; tenant?: TenantRecord } {
  const numberRec = body.To ? phoneNumbers.byE164(body.To) : undefined;
  const business = numberRec ? businesses.get(numberRec.businessId) : undefined;
  const tenant = business?.tenantId ? tenants.get(business.tenantId) : undefined;
  return { business, tenant };
}

/**
 * Reject webhooks that don't carry a valid Twilio signature (when we can
 * verify one). Numbers owned by a tenant subaccount are signed with THAT
 * subaccount's auth token; everything else with the master token.
 */
function verifyTwilio(req: FastifyRequest, tenant: TenantRecord | undefined): boolean {
  const authToken = tenantAuthToken(tenant) ?? config.twilioAuthToken;
  if (!authToken) return true; // no token configured — nothing to verify against (dev)
  return validateTwilioSignature({
    authToken,
    url: requestUrl(req),
    params: (req.body ?? {}) as Record<string, string>,
    signature: req.headers["x-twilio-signature"] as string | undefined,
  });
}

export function registerTwilioRoutes(app: FastifyInstance) {
  /**
   * Inbound call webhook. Twilio POSTs form data (To/From/CallSid...);
   * we answer with TwiML that opens a bidirectional media stream to us.
   */
  app.post("/twilio/voice", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const { business, tenant } = resolveCallee(body);
    if (!verifyTwilio(req, tenant)) return reply.code(403).send({ error: "invalid twilio signature" });
    const to = body.To ?? "";
    const from = body.From ?? "";

    const receptionist = business ? receptionists.activeForBusiness(business.id) : undefined;

    reply.type("text/xml");
    if (!business || !receptionist) {
      console.warn(`[twilio] call to unrecognized number ${maskPhone(to)}`);
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>This number is not configured yet. Goodbye.</Say><Hangup/></Response>`;
    }

    // One-time token proving the media stream comes from this verified webhook.
    const streamToken = mintStreamToken({ businessId: business.id, web: false });

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl(req as any))}">
      <Parameter name="businessId" value="${escapeXml(business.id)}"/>
      <Parameter name="from" value="${escapeXml(from)}"/>
      <Parameter name="token" value="${escapeXml(streamToken)}"/>
    </Stream>
  </Connect>
</Response>`;
  });

  /** Call status callbacks (optional wiring; useful for logs). */
  app.post("/twilio/status", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    if (!verifyTwilio(req, resolveCallee(body).tenant)) return reply.code(403).send({ error: "invalid twilio signature" });
    if (body.CallStatus) {
      console.log(`[twilio] call ${body.CallSid ?? "?"} status: ${body.CallStatus}`);
    }
    return "ok";
  });
}
