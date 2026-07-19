import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import path from "node:path";
import fs from "node:fs";
import { authMode, config, REPO_ROOT } from "./config.ts";
import { registerApiRoutes } from "./routes/api.ts";
import { registerTwilioRoutes } from "./routes/twilio.ts";
import { CallSession, type SessionDeps } from "./voice/session.ts";
import { businesses, receptionists } from "./db.ts";
import * as twilio from "./telephony/twilio.ts";
import { consumeStreamToken, safeEqual } from "./security.ts";
import { devContext, ensureUser, opsContext, verifySupabaseJwt, type AuthContext } from "./auth.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on every non-public /api request. */
    auth?: AuthContext;
  }
}

/** /api paths that skip auth (health checks, bootstrap config for the web app). */
const PUBLIC_API_PATHS = new Set(["/api/health", "/api/public/config"]);

export interface BuildAppOptions {
  /** Shrunk timers for tests. */
  sessionTimers?: SessionDeps["timers"];
}

/** Origins the browser may call us from: localhost dev, our own public URL, plus ALLOWED_ORIGINS. */
function originAllowed(origin: string): boolean {
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  try {
    if (config.publicUrl && new URL(config.publicUrl).origin === origin) return true;
  } catch {
    // malformed PUBLIC_URL — ignore
  }
  return config.allowedOrigins.includes(origin);
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Twilio posts application/x-www-form-urlencoded.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (err) {
      done(err as Error);
    }
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || originAllowed(origin)),
  });
  // Behind Cloudflare Tunnel every request egresses from localhost, so key
  // rate limits on the real client IP header when present.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      (req.headers["cf-connecting-ip"] as string) ||
      ((req.headers["x-forwarded-for"] as string) ?? "").split(",")[0].trim() ||
      req.ip,
  });
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  // Auth: every /api route (except PUBLIC_API_PATHS) resolves to a tenant context.
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.raw.url ?? "").split("?")[0];
    if (!path.startsWith("/api")) return;
    if (req.method === "OPTIONS") return; // CORS preflight carries no auth header
    if (PUBLIC_API_PATHS.has(path)) return;

    const header = (req.headers.authorization as string | undefined) ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";

    // Ops token: platform-admin context in every mode where it's configured.
    if (config.dashboardToken && bearer && safeEqual(bearer, config.dashboardToken)) {
      req.auth = opsContext();
      return;
    }

    switch (authMode()) {
      case "supabase": {
        const claims = bearer ? await verifySupabaseJwt(bearer) : undefined;
        if (!claims) return reply.code(401).send({ error: "unauthorized" });
        req.auth = ensureUser(claims);
        return;
      }
      case "token":
        // Only the ops token unlocks this mode, and it didn't match above.
        return reply.code(401).send({ error: "unauthorized" });
      case "open":
        req.auth = devContext();
        return;
    }
  });

  registerApiRoutes(app);
  registerTwilioRoutes(app);

  /** Resolve session deps from the stream's start message (Twilio or web dialer). */
  function resolveDeps(customParameters: Record<string, string>): SessionDeps | undefined {
    // Streams must prove where they came from before burning STT/LLM/TTS spend.
    // Both paths use single-use tokens bound to a business: phone streams get
    // one from the signature-verified /twilio/voice webhook, web dialers from
    // the authenticated POST /api/businesses/:id/stream-token.
    const grant = consumeStreamToken(customParameters.token);
    const isWeb = customParameters.web === "1";
    let businessId: string | undefined;
    if (grant) {
      businessId = grant.businessId; // token is authoritative, not the client-sent id
    } else if (isWeb && authMode() === "open") {
      businessId = customParameters.businessId; // zero-config local dev dialer
    } else if (!isWeb && !config.publicUrl && !config.twilioAuthToken) {
      businessId = customParameters.businessId; // local phone-protocol testing, no Twilio configured
    } else {
      return undefined;
    }
    if (!businessId) return undefined;
    const business = businesses.get(businessId);
    const receptionist = business ? receptionists.activeForBusiness(businessId) : undefined;
    if (!business || !receptionist) return undefined;
    return {
      business,
      receptionist,
      telephony: twilio.twilioConfigured()
        ? { transfer: twilio.transferCall, hangup: twilio.hangupCall }
        : undefined,
      timers: opts.sessionTimers,
    };
  }

  app.register(async (instance) => {
    instance.get("/media-stream", { websocket: true }, (socket) => {
      new CallSession(socket, resolveDeps);
    });
  });

  // Serve the built dashboard when it exists (production single-process mode).
  const webDist = path.join(REPO_ROOT, "web", "dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.raw.url?.startsWith("/api") ||
        req.raw.url?.startsWith("/twilio") ||
        req.raw.url?.startsWith("/media-stream")
      ) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
