import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

// Load .env from repo root (no dotenv dep — trivial parser).
const envPath = path.join(REPO_ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  /** Public base URL (https) used to build Twilio webhook/stream URLs. e.g. https://abc.ngrok.app */
  publicUrl: process.env.PUBLIC_URL || "",
  dbPath: process.env.DB_PATH || path.join(SERVER_ROOT, "data", "callcatcher.sqlite"),
  /** Force mock providers regardless of keys (for demos/tests). */
  mockProviders: process.env.MOCK_PROVIDERS === "1",

  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  openaiKey: process.env.OPENAI_API_KEY || "",
  deepgramKey: process.env.DEEPGRAM_API_KEY || "",
  elevenlabsKey: process.env.ELEVENLABS_API_KEY || "",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",

  /**
   * Ops bearer token: when set, presenting it on /api routes authenticates as
   * the platform-admin "ops" context (back-compat with pre-SaaS deployments,
   * break-glass access, and CLI scripts). Tenant users authenticate via
   * Supabase JWTs instead.
   */
  dashboardToken: process.env.DASHBOARD_TOKEN || "",

  /**
   * Optional shared secret that exempts the holder from the public demo's
   * per-IP/global voice-call throttles (see routes/api.ts demo-voice-token).
   * For the operator's own testing only — never advertise it publicly. The
   * per-call 60s hard cap still applies regardless.
   */
  demoDevKey: process.env.DEMO_DEV_KEY || "",

  // ---------- SaaS auth (Supabase) ----------
  /** Supabase project URL, e.g. https://abcd.supabase.co — enables supabase auth mode. */
  supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  /** Publishable anon key, served to the dashboard via /api/public/config. */
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  /** Legacy HS256 JWT secret (older Supabase projects; also how tests mint tokens). */
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || "",
  /** Emails that become platform admins and adopt legacy (pre-tenant) businesses. */
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** 64-hex-char key for AES-256-GCM encryption of stored secrets (subaccount tokens). */
  secretsKey: process.env.SECRETS_KEY || "",

  // ---------- billing (Stripe) ----------
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  /** Stripe price ids for the purchasable tiers (create in Stripe → Products). */
  stripePrices: {
    starter: process.env.STRIPE_PRICE_STARTER || "",
    pro: process.env.STRIPE_PRICE_PRO || "",
    scale: process.env.STRIPE_PRICE_SCALE || "",
  } as Record<string, string>,
  /** Dashboard origin for Stripe redirect URLs (falls back to PUBLIC_URL). */
  appUrl: (process.env.APP_URL || process.env.PUBLIC_URL || "").replace(/\/$/, ""),
  /** Extra browser origins allowed by CORS (comma-separated). localhost + PUBLIC_URL are always allowed. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),

  /** Model used inside live calls (latency-critical). */
  callModelAnthropic: process.env.CALL_MODEL_ANTHROPIC || "claude-haiku-4-5",
  callModelOpenai: process.env.CALL_MODEL_OPENAI || "gpt-4o-mini",
  /** Model used by the factory to author prompts / extract website info (quality-critical, one-shot). */
  factoryModel: process.env.FACTORY_MODEL || "claude-opus-4-8",
};

/**
 * How /api requests authenticate:
 *  - "supabase": Supabase JWTs required (SUPABASE_URL or SUPABASE_JWT_SECRET set).
 *    DASHBOARD_TOKEN additionally works as an ops/platform-admin bearer.
 *  - "token": legacy single-token mode (only DASHBOARD_TOKEN set).
 *  - "open": nothing configured — local dev auto-authenticates as a dev tenant.
 */
export type AuthMode = "supabase" | "token" | "open";

export function authMode(): AuthMode {
  if (config.supabaseUrl || config.supabaseJwtSecret) return "supabase";
  if (config.dashboardToken) return "token";
  return "open";
}

export interface ProviderStatus {
  stt: { deepgram: boolean; mock: true };
  llm: { anthropic: boolean; openai: boolean; mock: true };
  tts: { deepgram: boolean; elevenlabs: boolean; mock: true };
  telephony: { twilio: boolean };
  factoryAi: boolean;
  mockMode: boolean;
}

export function providerStatus(): ProviderStatus {
  return {
    stt: { deepgram: !!config.deepgramKey && !config.mockProviders, mock: true },
    llm: {
      anthropic: !!config.anthropicKey && !config.mockProviders,
      openai: !!config.openaiKey && !config.mockProviders,
      mock: true,
    },
    tts: {
      deepgram: !!config.deepgramKey && !config.mockProviders,
      elevenlabs: !!config.elevenlabsKey && !config.mockProviders,
      mock: true,
    },
    telephony: { twilio: !!(config.twilioAccountSid && config.twilioAuthToken) },
    factoryAi: !!config.anthropicKey && !config.mockProviders,
    mockMode: config.mockProviders,
  };
}

/** Pick sensible default providers given which keys exist. */
export function defaultProviders() {
  const s = providerStatus();
  return {
    stt: s.stt.deepgram ? "deepgram" : "mock",
    llm: s.llm.anthropic ? "anthropic" : s.llm.openai ? "openai" : "mock",
    tts: s.tts.deepgram ? "deepgram" : s.tts.elevenlabs ? "elevenlabs" : "mock",
  };
}
