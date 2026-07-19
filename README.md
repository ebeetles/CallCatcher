# ☎️ CallCatcher

**A factory for AI phone receptionists.** Type in a small business's details — hours, services,
FAQs, policies — and CallCatcher compiles them into a fully working AI receptionist on a real
phone number: it answers calls, speaks naturally, quotes prices, takes messages, books
appointment requests, transfers to a human, and logs every call with a transcript and cost.

Built as an agency tool: one operator can run receptionists for many businesses from a single
dashboard, at provider costs of roughly **$25–35/month per business** (12 calls/day) — whatever
you charge on top is margin.

## How it works

```
Caller ⇄ Twilio number ⇄ Media Stream (WebSocket, μ-law audio)
             ⇄ CallCatcher session
                 ├─ Deepgram STT (streaming, barge-in aware)
                 ├─ Claude (streaming, tools: messages/appointments/transfer/hangup)
                 └─ TTS (Deepgram Aura or ElevenLabs, per business)
```

- **The factory** ([server/src/promptFactory.ts](server/src/promptFactory.ts)) compiles a business
  profile into a voice-tuned system prompt. Open/closed status is computed **in code** from the
  business's timezone and injected per call — the LLM never does timezone math.
- **Providers are swappable per business** behind a registry
  ([server/src/providers/](server/src/providers/)): STT/LLM/TTS each have real adapters plus a
  mock, and any missing API key silently falls back to the mock — the whole product works with
  zero keys for development.
- **Every call is metered**: turns, interruptions, tokens, TTS characters, STT seconds, latency
  per turn, and an estimated dollar cost ([server/src/costs.ts](server/src/costs.ts)).

## Quick start

```bash
npm install
npm run dev        # API server on :8787 + dashboard on :5173
```

Open http://localhost:5173, click **Seed demo clinic**, and you have a working receptionist —
no API keys needed (mock providers answer scripted but profile-aware responses).

Try it without a phone:

- **Test call** tab — text chat against the receptionist's real prompt + tools via SSE.
- `npm run fake-call -w server` — a scripted caller speaks the actual Twilio Media Streams
  protocol over WebSocket against your running server: greeting, Q&A, an appointment booking,
  and a hangup land in the dashboard's call log with a full transcript.

## Going live (real phone calls)

1. Copy [.env.example](.env.example) to `.env` and add keys — see the file for details:
   `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`
   (optional: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`).
2. Expose the server over https and set `PUBLIC_URL`:
   ```bash
   ngrok http 8787          # → PUBLIC_URL=https://xxxx.ngrok.app
   ```
3. Restart, then in the dashboard: **business → Overview → Phone line** — search and buy a
   number (~$1.15/mo) or attach one you already own. CallCatcher configures the Twilio voice
   webhook (`$PUBLIC_URL/twilio/voice`) automatically.
4. Call the number.

## SaaS setup (multi-tenant)

Everything above runs CallCatcher as a single-operator console. It also runs as a
**multi-tenant SaaS**: agencies sign up with **Supabase Auth**, every `/api` route is scoped
to their tenant, each tenant gets an isolated **Twilio subaccount** for its numbers, usage is
metered per month, and **Stripe** handles subscriptions (Starter/Pro/Scale + 14-day trial)
via Checkout, the customer portal, and webhooks. One server + one SQLite file serves all
tenants; with no keys configured, everything still works in open dev mode.

- **[SAAS_SETUP.md](SAAS_SETUP.md)** — full setup guide: Supabase project, Stripe
  products/prices + webhook, Twilio subaccounts, env reference, go-live checklist,
  troubleshooting.
- **[SAAS_PLAN.md](SAAS_PLAN.md)** — architecture, locked decisions, and the phase-by-phase
  build plan.

## Dashboard tour

| Page | What you do there |
| --- | --- |
| **Businesses** | Every line at a glance: status lamp, number, calls today, active version. |
| **New business** | Profile form — or paste their website URL and let Claude fill it in. |
| **Receptionist** | Pick personality/voice/model/tools, preview the compiled prompt, deploy versions. |
| **Test call** | Text-mode conversation with the live receptionist, with latency + token readouts. |
| **Calls** | Full transcripts with barge-in markers, per-turn latency, and per-call cost. |
| **Inbox** | Messages and appointment requests the receptionist captured; confirm/decline. |
| **Rate card** | Cost calculator: calls/day × minutes × model/voice → monthly provider cost. |

## Commands

```bash
npm run dev          # server (tsx watch) + web (vite) together
npm test             # unit + integration tests (fake Twilio caller, mock providers)
npm run typecheck    # both workspaces
npm run build        # typecheck + production web build
npm run fake-call -w server   # scripted call against the running dev server
```

## Repo layout

```
server/
  src/
    promptFactory.ts     # profile → voice-tuned system prompt (+ {{NOW}} resolution)
    voice/session.ts     # per-call agent loop: STT → LLM → TTS, barge-in, timers
    agent/               # provider-agnostic agent turn + tool execution
    providers/           # stt/llm/tts adapters + registry (deepgram, anthropic, openai, elevenlabs, mock)
    telephony/twilio.ts  # minimal Twilio REST client (numbers, webhooks)
    routes/              # REST API + Twilio webhook + media-stream WS
    costs.ts             # pricing model + monthly estimator
  test/                  # unit + integration (fake caller speaks real Twilio protocol)
  scripts/fake-call.ts   # scripted dev caller
web/
  src/                   # operator dashboard (React + Vite)
```

## Notes

- **Data** lives in a single SQLite file (`server/data/callcatcher.sqlite` by default) — easy to
  back up, easy to blow away.
- **Deploying**: any Node 20+ host works. Run `npm run build`, serve the API with
  `npm start -w server`, and point `PUBLIC_URL` at your https origin. The server also serves the
  built dashboard from `web/dist` in production.
- **Costs**: rates in [server/src/costs.ts](server/src/costs.ts) were checked July 2026 — revisit
  when providers change pricing.
