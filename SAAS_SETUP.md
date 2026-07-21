# CallCatcher SaaS — Setup Guide

CallCatcher runs as a **multi-tenant B2B SaaS**: agencies sign up (Supabase Auth), get their
own isolated dashboard, build AI receptionists for their clients, and pay subscription tiers
(Stripe). Every tenant gets its own **Twilio subaccount** for isolated numbers and per-tenant
cost attribution. One shared Node server + one SQLite database serves all tenants.

This guide takes you from a fresh clone to a production SaaS. For the architecture rationale
and phase-by-phase history, see [SAAS_PLAN.md](SAAS_PLAN.md).

**The zero-config promise still holds:** with no keys at all, the server runs in `open` auth
mode with mock AI providers — the dashboard, chat simulator, and fake calls all work. Every
section below is additive; configure only what you need.

## Architecture overview

```
Browser ─ landing / auth pages ─ Supabase Auth (signup, login, verify, reset)
   │  Bearer <supabase access JWT>
   ▼
Fastify API ── verify JWT (JWKS w/ cache, or HS256 secret) ── users/tenants in SQLite
   │              first request bootstraps: user row + tenant row (+ Twilio subaccount)
   ├─ every /api route tenant-scoped (ownership checked via businesses.tenant_id)
   ├─ /twilio/voice: number → business → tenant → validate sig w/ subaccount token
   ├─ /stripe/webhook: raw-body signature verify → plan/status updates
   └─ media-stream WS: one-time tokens bound to businessId (web + phone unified)
        │
        ├─ Deepgram STT (streaming, barge-in aware)
        ├─ Claude (streaming, tools: messages/appointments/transfer/hangup)
        └─ TTS (Deepgram Aura or ElevenLabs, per business)
```

Provider keys are **managed**: all tenants run on the platform's Anthropic / Deepgram /
ElevenLabs keys. Telephony is isolated per tenant via Twilio subaccounts (created
automatically at tenant signup when platform Twilio keys + `SECRETS_KEY` are configured).

## Prerequisites

- **Node.js 20+** (the repo's `engines` field enforces `>=20`) and **npm**
- Accounts you'll need for full production mode: [Supabase](https://supabase.com),
  [Stripe](https://stripe.com), [Twilio](https://twilio.com),
  [Anthropic](https://console.anthropic.com), [Deepgram](https://deepgram.com), and
  optionally [ElevenLabs](https://elevenlabs.io)
- An https origin for the API in production (Twilio webhooks and Stripe webhooks must reach
  it). For local testing of real calls: a tunnel such as `ngrok`.

## Step 1 — Clone and install

```bash
git clone https://github.com/ebeetles/CallCatcher.git
cd CallCatcher
npm install          # installs both workspaces (server + web)
npm test             # sanity check: full suite runs green with zero keys
```

## Step 2 — Configure .env

```bash
cp .env.example .env
```

`.env.example` is fully commented and grouped into sections; the server reads `.env` from the
repo root at boot (no dotenv dependency). The groups:

| Group | Keys | What it enables |
| --- | --- | --- |
| server | `PORT`, `HOST`, `PUBLIC_URL`, `DB_PATH` | Where the API listens; the public https base Twilio calls back to |
| auth | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `ADMIN_EMAILS` | Multi-tenant signup/login (supabase auth mode) |
| security | `DASHBOARD_TOKEN`, `SECRETS_KEY`, `ALLOWED_ORIGINS`, `MOCK_PROVIDERS` | Ops bearer token; encryption-at-rest for tenant Twilio tokens; CORS |
| billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`, `APP_URL` | Checkout, customer portal, plan sync |
| AI providers | `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` | Real STT / LLM / TTS (any missing key falls back to a mock) |
| telephony | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Number purchase, inbound calls, per-tenant subaccounts |
| model choices | `CALL_MODEL_*`, `FACTORY_MODEL` | Optional model overrides |

The full per-variable reference is at the [bottom of this guide](#environment-reference).

**How auth mode is chosen** (automatic, exposed via `GET /api/public/config`):

- `supabase` — `SUPABASE_URL` (or `SUPABASE_JWT_SECRET`) is set. Real product mode; every
  `/api` request needs a Supabase JWT. `DASHBOARD_TOKEN` still works as an ops bearer.
- `token` — only `DASHBOARD_TOKEN` is set. Legacy single-operator mode.
- `open` — nothing set. Local dev; every request auto-authenticates as a `dev` tenant.

## Step 3 — Supabase project (auth)

Supabase is used for **auth only** — signup, login, email verification, password reset. No
business data leaves SQLite.

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. In the project's settings, find the **Project URL** and the **anon/publishable API key**.
   Put them in `.env`:
   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_ANON_KEY=<anon key>
   ```
3. `SUPABASE_JWT_SECRET` is only needed for **older projects** that sign JWTs with a shared
   HS256 secret (found under the project's JWT settings). Newer projects publish asymmetric
   keys and the server verifies via the JWKS endpoint automatically — leave it empty then.
4. Set `ADMIN_EMAILS=you@example.com` **before you first sign up**. Emails on this list
   become platform admins on signup: they see the `/admin` tenants view and adopt any legacy
   (pre-SaaS) businesses in the database.
5. In Supabase's auth settings, add your dashboard origin to the allowed redirect URLs so
   email-confirmation and password-recovery links land back on your app.

The web dashboard needs **no build-time configuration** — it fetches the Supabase URL + anon
key at runtime from `GET /api/public/config`.

### Google sign-in (optional, recommended)

The login/signup pages show a "Continue with Google" button; it's inert until you enable the
Google provider. No code or env changes — Supabase + Google config only:

1. **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)) →
   create/select a project → **APIs & Services → OAuth consent screen**: configure it
   (External; app name + support email). While it's in **Testing** only whitelisted users can
   log in — **Publish** it before real agencies sign up.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.**
   Under **Authorized redirect URIs** add the callback Supabase shows on its Google provider
   page: `https://<ref>.supabase.co/auth/v1/callback`. Copy the **Client ID** + **Client
   Secret**.
3. **Supabase → Authentication → Providers → Google**: flip **Enable** on, paste the Client ID
   (the "Client ID (for OAuth)" field — *not* the "Client IDs" One Tap box) and Client Secret,
   Save.
4. Ensure every origin the app runs on is in Supabase's **Redirect URLs** (step 5 above) —
   the OAuth round-trip returns there.

Gotchas: `provider is not enabled` means the Enable toggle didn't save; a redirect error means
the origin is missing from the allowlist.

## Step 4 — Stripe (billing)

Billing is optional: leave all `STRIPE_*` empty and plans are still enforced (trial → paywall)
but checkout buttons are disabled with an explainer. To enable it:

1. In the Stripe dashboard, create **three recurring products/prices** matching the tiers in
   [server/src/plans.ts](server/src/plans.ts):
   | Plan | Price | Businesses | Included min/mo |
   | --- | --- | --- | --- |
   | Starter | $49/mo | 1 | 300 |
   | Pro | $149/mo | 5 | 1,500 |
   | Scale | $399/mo | 15 | 6,000 |
2. Paste each price id (`price_…`) into `.env`:
   ```
   STRIPE_PRICE_STARTER=price_…
   STRIPE_PRICE_PRO=price_…
   STRIPE_PRICE_SCALE=price_…
   ```
3. Copy your secret key: `STRIPE_SECRET_KEY=sk_live_…` (or `sk_test_…` while testing).
4. Add a **webhook endpoint** pointing at `https://<your-api-host>/stripe/webhook` sending
   these events, and paste its signing secret into `STRIPE_WEBHOOK_SECRET`:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Set `APP_URL` to the dashboard origin Stripe should redirect back to after checkout/portal
   (defaults to `PUBLIC_URL` — set it explicitly if the dashboard is hosted elsewhere, e.g.
   on Vercel).
6. Local webhook testing: `stripe listen --forward-to localhost:8787/stripe/webhook` (the
   Stripe CLI prints a temporary `whsec_…` to use as `STRIPE_WEBHOOK_SECRET`).

The webhook is the source of truth: plan, plan status, and billing period are mirrored into
the tenant row on every subscription event. Cancellation also suspends the tenant's Twilio
subaccount; resubscribing reactivates it.

## Step 5 — Twilio (telephony + subaccounts)

1. From your Twilio account (the **master** account), copy the Account SID and Auth Token:
   ```
   TWILIO_ACCOUNT_SID=AC…
   TWILIO_AUTH_TOKEN=…
   ```
2. Generate the secrets-encryption key — **required for per-tenant subaccounts** (tenant
   subaccount auth tokens are stored AES-256-GCM encrypted at rest):
   ```bash
   openssl rand -hex 32     # → SECRETS_KEY
   ```
3. That's it. Subaccounts are created automatically when a tenant signs up (and lazily
   retried at their first number operation if creation failed). Numbers, inbound-call
   signature validation, transfers, and owner-notification SMS all use the tenant's
   subaccount credentials; if a tenant has no subaccount (dev tenants, or keys missing), the
   server falls back to the master account gracefully.
4. `PUBLIC_URL` must be set to the server's public https origin for real calls — CallCatcher
   configures each number's voice webhook to `$PUBLIC_URL/twilio/voice` automatically when a
   number is bought/attached.

## Step 6 — AI provider keys

All tenants run on these platform keys (managed-key model):

- `ANTHROPIC_API_KEY` — **required for real conversations.** Used for live call reasoning
  and for the factory (prompt refinement + website extraction).
- `DEEPGRAM_API_KEY` — streaming speech-to-text **and** the default text-to-speech (Aura).
- `ELEVENLABS_API_KEY` — optional premium TTS. Plan-gated: Trial/Pro/Scale tenants can pick
  ElevenLabs voices; Starter cannot (see `server/src/plans.ts`).
- `OPENAI_API_KEY` — optional alternate call-time LLM.

Any missing key silently falls back to the mock provider, so partial configuration is fine
during bring-up.

## Step 7 — Run it

```bash
npm run dev        # dev: API on :8787 (tsx watch) + dashboard on :5173 (vite)
```

Open http://localhost:5173. In supabase mode you'll see the landing page → sign up (use an
`ADMIN_EMAILS` address to become platform admin) → the console with the first-time setup
guide. Useful checks:

- `GET http://localhost:8787/api/health` — public liveness probe
- `GET http://localhost:8787/api/public/config` — auth mode, plan catalog, billingEnabled
- `npm run fake-call -w server` — scripted caller speaking the real Twilio Media Streams
  protocol against your dev server; the call lands in the dashboard with a transcript

## Development vs production

| | Development | Production |
| --- | --- | --- |
| Run | `npm run dev` (two watch processes) | `npm run build`, then `npm start -w server` |
| Dashboard | Vite dev server on :5173, proxies `/api` + `/media-stream` to :8787 | Served by the API server from `web/dist` (single origin) |
| Auth | `open` mode (no keys) or your real Supabase project | `supabase` mode |
| Providers | Mocks are fine; `MOCK_PROVIDERS=1` forces them | Real keys |
| Twilio reachability | `ngrok http 8787` → `PUBLIC_URL=https://…ngrok.app` | Your https origin as `PUBLIC_URL` |
| Stripe | `sk_test_…` + Stripe CLI webhook forwarding | Live keys + dashboard webhook endpoint |
| Database | `server/data/callcatcher.sqlite` (default) | Same, on persistent disk — set `DB_PATH`, back the file up |

If the dashboard is hosted on a different origin than the API (e.g. Vercel + a VPS), set
`ALLOWED_ORIGINS` to the dashboard origin and `APP_URL` for Stripe redirects.

## Go-live checklist

- [ ] `npm test` and `npm run build` green on the production box
- [ ] `SUPABASE_URL` + `SUPABASE_ANON_KEY` set; signup → email verify → login works end to end
- [ ] `ADMIN_EMAILS` contains your email and you signed up with it (check `/admin` loads)
- [ ] `SECRETS_KEY` generated (`openssl rand -hex 32`) and **backed up** — losing it orphans
      stored subaccount tokens
- [ ] `DASHBOARD_TOKEN` generated (`openssl rand -hex 24`) and stored somewhere safe
      (break-glass ops access)
- [ ] Twilio master keys set; a test tenant signup creates a subaccount (check the tenant row
      or Twilio console → Subaccounts)
- [ ] `PUBLIC_URL` is the real https origin; buy a test number and call it
- [ ] Stripe **live-mode** products/prices created; price ids in `.env`; webhook endpoint
      added with the three events; a test checkout updates the tenant's plan
- [ ] `APP_URL` points at the real dashboard origin (checkout redirects land correctly)
- [ ] Anthropic + Deepgram keys set (calls talk); ElevenLabs if you sell premium voices
- [ ] SQLite file on persistent storage with backups (`DB_PATH`)
- [ ] Server supervised (systemd, pm2, or your platform's process manager) and restarts on boot

## Environment reference

| Variable | Required for | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | — | Default `8787` / `0.0.0.0` |
| `PUBLIC_URL` | Real phone calls | Public https base for Twilio webhooks + media stream |
| `DB_PATH` | — | Default `server/data/callcatcher.sqlite` |
| `SUPABASE_URL` | SaaS auth | Setting it switches the API to `supabase` auth mode |
| `SUPABASE_ANON_KEY` | SaaS auth | Served to the dashboard via `/api/public/config` |
| `SUPABASE_JWT_SECRET` | Legacy Supabase projects only | HS256 fallback; leave empty for JWKS projects |
| `ADMIN_EMAILS` | Platform admin | Comma-separated; set before first signup |
| `DASHBOARD_TOKEN` | Ops access / token mode | `openssl rand -hex 24` |
| `SECRETS_KEY` | Twilio subaccounts | 64 hex chars; `openssl rand -hex 32`; encrypts subaccount tokens at rest |
| `ALLOWED_ORIGINS` | Cross-origin dashboard | Comma-separated extra CORS origins |
| `MOCK_PROVIDERS` | — | `1` forces mock providers (demos, tests) |
| `STRIPE_SECRET_KEY` | Billing | `sk_live_…` / `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | Billing | Signing secret of the `/stripe/webhook` endpoint |
| `STRIPE_PRICE_STARTER` / `_PRO` / `_SCALE` | Billing | Price ids mapping Stripe → plans |
| `APP_URL` | Billing redirects | Dashboard origin; defaults to `PUBLIC_URL` |
| `ANTHROPIC_API_KEY` | Real calls + factory | Call reasoning, prompt authoring, website extraction |
| `OPENAI_API_KEY` | — | Optional alternate call LLM |
| `DEEPGRAM_API_KEY` | Real calls | Streaming STT + default TTS (Aura) |
| `ELEVENLABS_API_KEY` | Premium voices | Plan-gated per `server/src/plans.ts` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Telephony | Master account; subaccounts are provisioned under it |
| `CALL_MODEL_ANTHROPIC` / `CALL_MODEL_OPENAI` | — | Live-call model overrides |
| `FACTORY_MODEL` | — | Prompt-factory model override |

## Troubleshooting

**Every `/api` request returns 401 after setting `SUPABASE_URL`.**
Expected — that env var switches the server to `supabase` auth mode, and requests now need a
Supabase JWT (or the `DASHBOARD_TOKEN` bearer for ops). Unset it to return to token/open mode.

**Signup works but the user isn't a platform admin.**
`ADMIN_EMAILS` is checked at first-signup bootstrap. Make sure the email was on the list
*before* the account's first authenticated request, and that it matches case-insensitively.

**Stripe webhook returns 400 "signature verification failed".**
The signature is computed over the exact raw request body — a proxy that re-serializes JSON
breaks it. Also confirm `STRIPE_WEBHOOK_SECRET` matches *this* endpoint (each endpoint, and
each `stripe listen` session, has its own secret).

**Checkout button says billing is not configured / returns 501.**
One of `STRIPE_SECRET_KEY` or the `STRIPE_PRICE_*` ids is missing. All must be set for the
plan buttons to go live.

**A tenant paid but their plan didn't change.**
The webhook is the sync path. Check the Stripe dashboard's webhook delivery log for failures,
and verify the subscription's price id matches one of the `STRIPE_PRICE_*` values (that map is
how a price becomes a plan).

**No Twilio subaccount is created for new tenants.**
Subaccount creation is skipped gracefully when `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` or
`SECRETS_KEY` are missing, and for `dev`-plan tenants (they use the master account). It is
retried lazily at the tenant's first number operation once configured.

**Inbound calls get a polite "unavailable" message.**
That's plan enforcement: the tenant's plan is inactive (trial expired / canceled / suspended;
`past_due` keeps working while Stripe retries) or the month's included minutes are exhausted. The dashboard shows why on the Usage and
Billing pages; dashboard reads are never blocked.

**Twilio hits the webhook but the call errors (403).**
Signature validation failed. `PUBLIC_URL` must exactly match the origin Twilio requests
(scheme + host, no trailing path), since the signature covers the full URL.

**The receptionist answers with scripted/mock lines.**
The relevant provider key is missing or `MOCK_PROVIDERS=1` is set — the registry silently
falls back to mocks. Check the "System" lamps in the dashboard rail.

**Where's my data?**
One SQLite file: `server/data/callcatcher.sqlite` (or `DB_PATH`). Copy it to back up
everything; delete it to reset. The server is safe to restart mid-operation (WAL mode).
