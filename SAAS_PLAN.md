# CallCatcher SaaS — Productization Plan

Turn CallCatcher from a single-operator agency console into a multi-tenant B2B SaaS:
agencies sign up, get their own dashboard, build AI receptionists for their clients, and pay
subscription tiers. This file is the **stable plan**; live execution state is tracked in
[SAAS_PROGRESS.md](SAAS_PROGRESS.md).

## Locked decisions (2026-07-19, with Elwin)

| Decision | Choice |
| --- | --- |
| Provider keys | **Managed** — all tenants run on the platform's Anthropic/Deepgram/ElevenLabs keys; each tenant gets its own **Twilio subaccount** (isolated numbers, per-tenant cost attribution, suspend on churn). BYOK deferred (architecture leaves room). |
| Billing | **Stripe** Checkout + Customer Portal + webhooks. Config-driven tiers (below), 14-day free trial, hard caps in v1 (no metered overage billing yet). |
| Auth | **Supabase Auth** — hosted signup/login/email-verify/password-reset. Server verifies Supabase JWTs (JWKS or HS256 secret) and maps `sub` → local `users`/`tenants` rows in SQLite. No user data moves to Supabase besides auth. |
| Infra | **Single shared server + SQLite (WAL)** serves all tenants. Calls are I/O-bound; one box handles dozens of concurrent calls. Data layer stays thin so a Postgres move is mechanical later. No per-customer servers. |

## Tier defaults (all in `server/src/plans.ts`, changeable anytime)

| Plan | Price | Businesses | Included min/mo | ElevenLabs voices |
| --- | --- | --- | --- | --- |
| Trial (14d) | $0 | 1 | 60 | yes |
| Starter | $49/mo | 1 | 300 | no |
| Pro | $149/mo | 5 | 1,500 | yes |
| Scale | $399/mo | 15 | 6,000 | yes |

Enforcement: business creation past cap → 402 + upgrade prompt. Inbound calls past the minute
cap or with an inactive plan → polite "line unavailable" TwiML. Dashboard shows usage banner at
80%. Web test chat keeps working while over minute cap (evaluation path) but not when the plan
is inactive.

## Architecture

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
```

- **Auth modes** (server picks automatically, exposed via `GET /api/public/config`):
  - `supabase` — SUPABASE_URL set. Real product mode.
  - `token` — legacy DASHBOARD_TOKEN only (current prod deploy keeps working; token acts as
    platform-admin).
  - `open` — nothing set; local dev auto-auths as a `dev` tenant (mock-provider philosophy).
- **Tenant bootstrap** (first authenticated request): create `users` row from JWT (`sub`,
  email, `user_metadata.agency_name`), create tenant with trial plan, create Twilio subaccount
  when platform Twilio keys exist. Emails in `ADMIN_EMAILS` become `platform_admin` and adopt
  legacy (NULL-tenant) businesses.
- **Secrets at rest**: subaccount auth tokens encrypted AES-256-GCM with `SECRETS_KEY`.
- **Usage metering**: per-call metrics already exist; on call end, upsert into
  `usage_monthly (tenant_id, month, calls, seconds, est_cost_usd)`. Survives business deletion
  (billing record).

## Schema additions

```sql
tenants  (id, name, plan, plan_status, trial_ends_at, stripe_customer_id,
          stripe_subscription_id, current_period_end, twilio_subaccount_sid,
          twilio_subaccount_token_enc, created_at, updated_at)
users    (id /* supabase sub */, tenant_id→tenants, email, role, platform_admin, created_at)
businesses + tenant_id (nullable; NULL = legacy, adopted by first ADMIN_EMAILS tenant)
usage_monthly (tenant_id, month 'YYYY-MM', calls, seconds, est_cost_usd, PK(tenant_id, month))
```

## New/changed env

```
SUPABASE_URL=            # https://<ref>.supabase.co — enables supabase auth mode
SUPABASE_JWT_SECRET=     # optional HS256 fallback (legacy projects; used by tests)
ADMIN_EMAILS=            # comma-separated; platform admins + legacy-data adoption
SECRETS_KEY=             # 64 hex chars; encrypts stored subaccount tokens
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER= STRIPE_PRICE_PRO= STRIPE_PRICE_SCALE=   # Stripe price ids
APP_URL=                 # dashboard origin for Stripe redirects (default PUBLIC_URL)
```

Web needs **no** new build-time env: the dashboard fetches `GET /api/public/config`
(supabase url + anon key, auth mode, plans, billingEnabled) at runtime from the API it already
knows.

## Phases

### Phase 1 — Server: tenancy + Supabase auth ✅ shippable alone
- `jose` dep. `auth/` module: JWKS (cached) + HS256 verification, issuer/audience checks.
- Schema: tenants/users/usage_monthly tables, businesses.tenant_id, indexes.
- onRequest hook replaces DASHBOARD_TOKEN-only auth: public paths → pass; DASHBOARD_TOKEN →
  platform admin; Supabase JWT → verify + bootstrap; open mode → dev tenant.
- Tenant-scope EVERY route (today `/api/businesses/:id` has zero ownership checks):
  `ownedBusiness()` helper; sub-resources (calls/messages/appointments/receptionists/numbers)
  checked via JOIN to businesses. 404 on foreign ids (don't leak existence).
- Media-stream tokens: bind token → businessId; new `POST /api/businesses/:id/stream-token`
  for the web dialer; phone path unchanged mechanics, now carries businessId in token.
- Per-tenant rate limits on expensive routes (chat, extract-website).
- seed-demo per tenant. `/api/health` public. `/api/status` gains tenant/plan info.
- Tests: new tenancy.test.ts (two JWT-minted tenants, full isolation matrix), adapt
  security.test.ts (admin token, stream-token flow), integration stays green in open mode.

### Phase 2 — Web: auth + app shell
- `@supabase/supabase-js`. AuthProvider reads `/api/public/config`, initializes client,
  exposes session; api.ts attaches the current access token; 401 → login.
- Pages: Login, Signup (email, password, agency name → user_metadata), Reset password.
- Logged-out shell: landing + auth routes. Logged-in: existing console + account menu
  (agency name, email, sign out). `token`/`open` modes keep current behavior (TokenGate / none).

### Phase 3 — Twilio subaccounts
- Refactor `telephony/twilio.ts` to a credential-parameterized client. Platform client keeps
  master-account ops (create/suspend/reactivate/close subaccounts); tenant client (subaccount
  creds, decrypted) does numbers/calls/SMS. Fallback to master creds when tenant has no
  subaccount (legacy + dev).
- Subaccount auto-created at tenant bootstrap; lazy retry on first number operation.
- `/twilio/voice` + `/twilio/status` validate signatures with the number-owning tenant's token.
- Number search (master ok) / provision / attach / list / release via tenant subaccount.
- Session telephony actions (transfer/hangup) + owner-notify SMS use tenant creds.

### Phase 4 — Plans, metering, enforcement
- `plans.ts` (tiers above) + `entitlements(tenant)` resolver (trial expiry, plan status).
- usage_monthly upsert in `calls.end()` (JOIN business → tenant). `GET /api/usage` (month
  totals + per-business breakdown). Usage page + 80% banner in web.
- Enforce: business cap (402), inbound-call minute cap / inactive plan (TwiML unavailable),
  web chat blocked only when plan inactive. Paywall screen for expired trials.

### Phase 5 — Stripe billing
- `stripe` dep. `/api/billing/checkout` (plan → Checkout Session, customer reuse),
  `/api/billing/portal`, `/stripe/webhook` (raw-body verify; checkout.session.completed,
  customer.subscription.updated/deleted → plan/status/period sync; price-id → plan map).
- Billing page: current plan card, usage vs cap, tier grid → checkout, Manage billing →
  portal, trial countdown. Graceful "billing not configured" mode.
- Suspend tenant subaccount on terminal cancellation; reactivate on resubscribe.
- Tests with stripe's generateTestHeaderString.

### Phase 6 — Landing, onboarding, admin
- Public landing page (hero, how-it-works, live pricing from config, CTA → signup).
- Onboarding empty-state for new tenants (create first client / seed demo).
- `/admin` (platform_admin only): tenants list w/ plan, usage, created, suspend/reactivate.

### Phase 7 — Docs, security sweep, final verify
- README rewrite (SaaS quick start), SAAS_SETUP.md (Supabase project + Stripe products +
  webhook setup, env reference, go-live checklist), .env.example, DEPLOY.md addendum.
- Security sweep: route-by-route scoping audit, rate limits, secrets, webhook paths.
- Full test suite + typecheck + build; end-to-end browser verification of signup → create
  business → test call → usage → billing.

## Scaling path (documented, not built now)
1. Today: one Node process, SQLite WAL — fine to ~50–100 concurrent calls.
2. Vertical first: bigger box; better-sqlite3 is sync/fast, calls are network-bound.
3. Horizontal later: move sessions' one-time tokens + rate limits to Redis, SQLite → Postgres
   (data layer is already a thin module), sticky-route media-stream WS by call, N stateless
   API replicas. Twilio subaccounts and Supabase auth are already horizontal-safe.

## Working agreements
- Branch: `feature/saas-platform`; commit at each phase boundary (no pushes unless asked).
- Tests + typecheck green at every phase boundary; existing zero-key dev experience must keep
  working (open mode) — that's the repo's core philosophy.
- Update SAAS_PROGRESS.md as work lands so any session can resume from it.
