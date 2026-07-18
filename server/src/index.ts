import { buildApp } from "./app.ts";
import { config, providerStatus } from "./config.ts";

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  const s = providerStatus();
  const on = (b: boolean) => (b ? "✓" : "—");
  console.log(`
  ☎️  CallCatcher server on http://localhost:${config.port}
      STT  deepgram ${on(s.stt.deepgram)}   LLM  anthropic ${on(s.llm.anthropic)}  openai ${on(s.llm.openai)}   TTS  deepgram ${on(s.tts.deepgram)}  elevenlabs ${on(s.tts.elevenlabs)}
      Twilio ${on(s.telephony.twilio)}   Factory AI ${on(s.factoryAi)}   ${s.mockMode ? "(MOCK_PROVIDERS=1 — all mock)" : ""}
      ${config.publicUrl ? `Public URL: ${config.publicUrl}` : "PUBLIC_URL not set — needed for real phone calls (use an https tunnel like ngrok)"}
`);
  if (config.publicUrl && !config.dashboardToken) {
    console.warn(
      "  ⚠️  PUBLIC_URL is set but DASHBOARD_TOKEN is not — the dashboard API (transcripts, config,\n" +
        "      number provisioning) is open to anyone who can reach this server.\n" +
        "      Generate one with `openssl rand -hex 24` and set DASHBOARD_TOKEN in .env.\n"
    );
  }
  if (config.publicUrl && !config.twilioAuthToken) {
    console.warn("  ⚠️  PUBLIC_URL is set but TWILIO_AUTH_TOKEN is not — Twilio webhook signatures can't be verified.\n");
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
