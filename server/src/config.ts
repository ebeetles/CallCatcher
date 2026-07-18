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
   * Bearer token required on every /api route (and web test streams) when set.
   * Leave empty for tokenless local dev; REQUIRED once the server is public.
   */
  dashboardToken: process.env.DASHBOARD_TOKEN || "",
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
