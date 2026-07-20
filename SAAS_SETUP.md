# CallCatcher SaaS — Operator Setup

How to run CallCatcher as a **multi-tenant product**: agencies sign up, get their own
dashboard, build receptionists for their clients, and pay you monthly. This guide covers the
one-time setup (Supabase, Stripe, env) and how the machinery behaves. Architecture and build
history live in [SAAS_PLAN.md](SAAS_PLAN.md) / [SAAS_PROGRESS.md](SAAS_PROGRESS.md).

## How multi-tenancy works (60 seconds)

- **Auth**: Supabase Auth issues JWTs; the server verifies them (JWKS, or the legacy HS256
  secret) and maps each user to a local `tenants` row in SQLite. No app data lives in
  Supabase — it only does signup/login/verification/reset emails.
- **Isolation**: every API route is tenant-scoped; foreign ids return 404. Each paying tenant
  gets its **own Twilio subaccount** (numbers, calls, SMS, webhook signatures) under your
  master account. Subaccount auth tokens are AES-256-GCM encrypted with `SECRETS_KEY`.
- **Provider keys**: all tenants run on **your** Anthropic/Deepgram/ElevenLabs keys. Usage is
  metered per tenant per month (`usage_monthly`) and enforced against plan caps.
- **Plans** (edit [server/src/plans.ts](server/src/plans.ts)): Trial 14d / Starter $49 /
  Pro $149 / Scale $399. Hard caps: business count (402 at creation) and included minutes
  (inbound calls get a polite "unavailable" message when exhausted or the plan is inactive).
  Dashboards stay readable when locked — data is never hostage.
- **Billing**: Stripe Checkout + Customer Portal; webhooks keep `plan`/`plan_status` in sync.
  Cancellation suspends the tenant's Twilio subaccount; resubscribing reactivates it.
- **Your own account**: emails in `ADMIN_EMAILS` become platform admins on signup — they get
  the unlimited `dev` plan, run on the master Twilio account, adopt all pre-SaaS businesses,
  and see the **Tenants** admin page (suspend/reactivate any agency).

## 1. Supabase (auth)

1. Create a project at supabase.com (free tier is fine — it only handles auth).
2. Project Settings → API: copy the **Project URL** and **anon/publishable key** into
   `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. Authentication → Providers: keep **Email** enabled. Leave "Confirm email" on (recommended);
   Supabase sends verification + password-reset emails for you.
4. Authentication → URL Configuration: set **Site URL** to your dashboard origin
   (e.g. `https://callcatcher.vercel.app`) and add `https://<dashboard>/reset` to
   **Redirect URLs** (password-reset flow lands there).
5. Older projects only: if your project still uses the legacy HS256 JWT secret (Settings →
   API → JWT Secret), also set `SUPABASE_JWT_SECRET`. New projects publish asymmetric keys and
   need nothing — the server fetches the JWKS automatically.
6. Put **your** email in `ADMIN_EMAILS` **before your first sign-in** so your account becomes
   the platform admin and adopts the existing businesses.

The dashboard needs **no** Supabase env of its own — it fetches `GET /api/public/config` at
runtime. No Vercel changes are required beyond what DEPLOY.md already set up.

### Google sign-in (optional, recommended)

The login/signup pages show a "Continue with Google" button; it's inert until you wire up the
Google provider. No code or env changes — it's all Supabase + Google config:

1. **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)) →
   create/select a project → **APIs & Services → OAuth consent screen**: configure it
   (External; app name + support email). While it's in **Testing** only whitelisted users can
   log in — **Publish** it before real agencies sign up.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.**
   Under **Authorized redirect URIs** add the callback Supabase shows on its Google provider
   page: `https://<ref>.supabase.co/auth/v1/callback`. Copy the **Client ID** + **Client
   Secret**.
3. **Supabase → Authentication → Providers → Google**: flip **Enable** on, paste the Client ID
   (the "Client ID (for OAuth)" field — *not* the "Client IDs" One Tap box below it) and Client
   Secret, Save.
4. **Supabase → Authentication → URL Configuration**: make sure every origin the app runs on is
   in **Redirect URLs** (`http://localhost:5173` for dev, your production URL for prod) — the
   OAuth round-trip returns there.

Gotchas: `provider is not enabled` means the Enable toggle didn't save; a redirect error means
the origin is missing from step 4's allowlist.

## 2. Stripe (billing)

1. Create three recurring monthly **Products/Prices** matching `plans.ts`:
   Starter $49, Pro $149, Scale $399. Copy each **price id** (`price_…`) into
   `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_SCALE`.
2. Developers → API keys: copy the **secret key** into `STRIPE_SECRET_KEY`.
3. Developers → Webhooks → Add endpoint: `https://<your-api-host>/stripe/webhook`, events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy the **signing secret** into `STRIPE_WEBHOOK_SECRET`.
4. Set `APP_URL` to the dashboard origin (checkout redirects there). Defaults to `PUBLIC_URL`.
5. Enable the **Customer Portal** (Settings → Billing → Customer portal) so "Manage billing"
   works.
6. Local testing: `stripe listen --forward-to localhost:8787/stripe/webhook` and use the
   printed `whsec_…` as `STRIPE_WEBHOOK_SECRET`.

Changing prices later: edit `plans.ts` (display/limits) **and** create new Stripe prices,
then update the `STRIPE_PRICE_*` envs. Existing subscribers keep their old Stripe price until
you migrate them in Stripe.

Leave all Stripe vars empty to run without billing — signup/trials/enforcement still work;
checkout buttons explain that billing isn't configured. While unbilled you can hand-set a
tenant's plan directly in SQLite (`UPDATE tenants SET plan='pro' WHERE id='tnt_…'`).

## 3. Env reference (new SaaS vars)

| Var | Required for | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | accounts | switches API to supabase auth mode |
| `SUPABASE_JWT_SECRET` | legacy projects/tests | HS256 fallback verification |
| `ADMIN_EMAILS` | you | platform admins + legacy-data adoption at first sign-in |
| `SECRETS_KEY` | subaccounts | `openssl rand -hex 32`; encrypts subaccount tokens at rest |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | billing | see §2 |
| `APP_URL` | billing redirects | dashboard origin; defaults to `PUBLIC_URL` |
| `DASHBOARD_TOKEN` | ops | now a **platform-admin** bearer for curl/scripts/break-glass |

Everything else (`PUBLIC_URL`, provider keys, `ALLOWED_ORIGINS`, …) is unchanged from
[.env.example](.env.example) / [DEPLOY.md](DEPLOY.md).

## 4. Migrating your current deployment

Your existing single-tenant data keeps working through every step:

1. Pull this branch on the Beelink, `npm install`, restart. Nothing else set → the API runs in
   **token mode**: the dashboard still unlocks with `DASHBOARD_TOKEN`, and your businesses are
   "legacy" rows visible to that ops context.
2. Add the Supabase vars + `ADMIN_EMAILS=you@…` + `SECRETS_KEY`, restart. The dashboard now
   shows the landing page; **sign up with your admin email** — your account adopts every
   legacy business permanently. From here you use your own login; the token remains as an ops
   key for curl.
3. Add Stripe vars when you're ready to charge.

## 5. Go-live checklist

- [ ] `curl https://<api>/api/health` → `{"ok":true}`; `/api/public/config` shows
      `authMode: "supabase"`, `billingEnabled: true`, and your plan catalog
- [ ] Sign up with `ADMIN_EMAILS` address → Tenants nav visible, legacy businesses present
- [ ] Google sign-in works **and** the OAuth consent screen is **Published** (not Testing);
      production origin is in Supabase's Redirect URLs
- [ ] Fresh signup with a throwaway email → verify email → lands on empty console, trial
      banner, seed demo works, second business blocked with upgrade prompt
- [ ] Test checkout with Stripe test card `4242 4242 4242 4242` → plan flips to paid,
      webhook log line `[billing] tenant … → plan=…`
- [ ] New tenant provisions a number → Twilio console shows it inside a **subaccount** named
      `CallCatcher <agency>`; call it; transcript lands in their console only
- [ ] `stripe trigger customer.subscription.deleted` (test mode) → tenant paywalled,
      subaccount suspended
- [ ] `npm test` green on the box

## 6. Security model (what's enforced where)

- Every `/api` route (minus `/api/health`, `/api/public/config`) requires auth; tenant
  scoping is enforced in queries (`tenant_id` filter or JOIN through `businesses`), not in UI.
- Twilio webhooks are signature-verified with the **number-owning tenant's** subaccount token
  (master token for legacy numbers). Media streams need single-use tokens bound to a business
  — minted only by the verified webhook or an authenticated dashboard request.
- Stripe webhooks are signature-verified over the raw body; the endpoint has no other auth.
- Phone numbers are unique per platform; attaching a number mapped to another tenant → 409.
- Subaccount tokens encrypted at rest (`SECRETS_KEY`); Supabase handles password storage.
- Rate limits: 300 req/min/IP global, 30/min chat, 10/min website-extraction. Plan caps bound
  AI spend per tenant. (Per-tenant rate keys are a scaling-phase upgrade — see §7.)

## 7. Scaling path (when you outgrow one box)

1. **Now**: one Node process + SQLite WAL serves all tenants; calls are network-bound. A
   Beelink-class box comfortably runs dozens of concurrent calls.
2. **Vertical**: bigger box, same architecture. Watch `usage_monthly.est_cost_usd` vs revenue.
3. **Horizontal (later)**: move stream tokens + rate limits to Redis, SQLite → Postgres (the
   data layer is one module, `server/src/db.ts`), run N stateless API replicas behind a
   load balancer with sticky WebSocket routing. Supabase auth, Twilio subaccounts, and Stripe
   are already horizontal-safe.
