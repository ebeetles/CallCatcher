# SaaS build — live progress

Plan: [SAAS_PLAN.md](SAAS_PLAN.md). Update this file as work lands; any session resumes from here.

## Status: ALL 7 PHASES COMPLETE (2026-07-19) — awaiting Elwin's external setup

The codebase is a working multi-tenant SaaS. What's left needs Elwin's accounts (steps in
[SAAS_SETUP.md](SAAS_SETUP.md)):

1. Create the Supabase project → `SUPABASE_URL`/`SUPABASE_ANON_KEY` + `ADMIN_EMAILS` + `SECRETS_KEY` in `.env`
2. Create Stripe products/prices + webhook → `STRIPE_*` + `APP_URL`
3. Deploy branch `feature/saas-platform` (merge to main when happy), run go-live checklist in SAAS_SETUP.md §5
4. First real-Supabase e2e signup happens then (API-level JWT flow already fully tested)

62 tests green · typecheck clean · production build passes · browser-verified (landing,
auth gates, console, usage, admin, fake call, SSE chat).

- [x] Phase 0 — Plan written, decisions locked (managed keys + Twilio subaccounts, Stripe
      w/ default tiers, Supabase Auth, single server + SQLite). Branch `feature/saas-platform`.
- [x] **Phase 1 — Server tenancy + Supabase auth** (2026-07-19)
  - [x] deps: `jose`
  - [x] config: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET / ADMIN_EMAILS + authMode()
  - [x] schema: tenants, users, usage_monthly, businesses.tenant_id (+ indexes)
  - [x] auth.ts (JWKS + HS256 verify, ensureUser bootstrap, admin adoption, ops/dev contexts,
        setTenantCreatedHook for Phase 3 subaccounts)
  - [x] onRequest auth hook (supabase / token / open) + /api/public/config + /api/health
  - [x] tenant scoping on every route (businesses, receptionists, numbers, calls, messages,
        appointments, chat, seed-demo) — foreign ids → 404
  - [x] stream tokens carry {businessId, web} grants; POST /api/businesses/:id/stream-token;
        token's grant is authoritative over client-sent businessId
  - [x] fake-call script mints a stream token first (tokenless fallback for open mode)
  - [x] tests: tenancy.test.ts (auth gate, isolation matrix, per-tenant seed, stream tokens,
        admin adoption) — 41 tests green; typecheck clean
  - Deferred to P7 sweep: per-tenant rate-limit keying on chat/extract-website (IP-keyed today)
- [x] **Phase 2 — Web auth + shell** (2026-07-19)
  - [x] @supabase/supabase-js; AuthProvider fetches /api/public/config at runtime (no new
        build-time env for Vercel), initializes client, tracks session
  - [x] api.ts: pluggable async auth-token getter (supabase JWT / dashboard token / none)
  - [x] Login / Signup (agency name → user_metadata.agency_name) / Reset (request + recovery
        set-password) pages; check-email states
  - [x] App split: AuthProvider → Gate (login routes when signed out in supabase mode) →
        Console (original shell + Account rail w/ tenant name, plan, sign out)
  - [x] token mode keeps TokenGate; open mode gates nothing
  - [x] vite proxy target overridable via CC_API_PROXY (dev-alongside-live-server); launch.json
        gained callcatcher-web-alt-api (proxies to :8788)
  - [x] Verified in browser: open mode → console w/ Dev Agency rail; supabase mode → sign-in
        gate + signup page; 401 on bare /api. Tests 41 green, both typechecks clean.
  - Note: e2e signup against a REAL Supabase project deferred to Phase 7 (needs Elwin's
    project + keys); API-level JWT flow fully covered by tenancy.test.ts.
- [x] **Phase 3 — Twilio subaccounts** (2026-07-19)
  - [x] crypto.ts: AES-256-GCM secret storage (SECRETS_KEY, 64 hex)
  - [x] telephony/twilio.ts → credential-parameterized TwilioClient class;
        platformTwilio() / tenantTwilio(tenant) resolution (subaccount → master fallback)
  - [x] subaccount lifecycle: createSubaccount + setSubaccountStatus(active|suspended|closed);
        ensureTenantSubaccount (idempotent, lazy retry at number provisioning);
        auto-provisioned via tenant-created hook; SKIPPED for plan-"dev" tenants (they run
        on the master account) and when keys/SECRETS_KEY missing (graceful fallback)
  - [x] /twilio/voice + /twilio/status validate signatures with the number-owning tenant's
        subaccount token (master token for legacy/unknown numbers)
  - [x] number search/provision/attach/owned-numbers + call transfer/hangup + owner SMS all
        route through tenantTwilio
  - [x] subaccounts.test.ts (fetch-stubbed Twilio API): encrypted-at-rest, lifecycle,
        purchase-in-subaccount, per-tenant signature matrix — 49 tests green
  - Suspend/reactivate invocation wired in P5 (Stripe cancel) + P6 (admin actions)
- [x] **Phase 4 — Plans + metering + enforcement** (2026-07-19)
  - [x] plans.ts: trial/starter/pro/scale/dev tiers + entitlements() + entitlementSummary()
  - [x] usage accessor (usage_monthly upsert) fed by calls.end() via business→tenant join;
        perBusinessMonth breakdown; GET /api/usage; usage summary in /api/status auth block
  - [x] enforcement: business cap 402 (create + seed-demo), inactive plan 402 on
        chat/stream-token/create, inbound calls blocked w/ polite TwiML when inactive OR
        minutes exhausted; dashboard reads never blocked (data isn't hostage)
  - [x] /api/public/config exposes the purchasable plan catalog
  - [x] web: Usage page (stats, meter bar, per-business table), UsageBanner (80%/exhausted/
        trial-ending), Paywall lock (billing+reset stay reachable), Billing page stub (Stripe
        buttons land in P5), nav links
  - [x] plans.test.ts: catalog, cap 402, rollup, webhook minute-block, trial-expiry lockout,
        upgrade unlock — 55 tests green; fake-call verified e2e in browser w/ usage rollup
- [x] **Phase 5 — Stripe billing** (2026-07-19)
  - [x] billing/stripe.ts: checkout sessions (customer reuse, plan metadata, promo codes),
        customer portal, webhook event sync (checkout.completed, subscription.updated/deleted
        → plan/plan_status/period mirror; price-id → plan map from STRIPE_PRICE_* envs)
  - [x] subaccount suspend on cancellation, reactivate on resubscribe
  - [x] routes: POST /api/billing/checkout + /portal; POST /stripe/webhook in an encapsulated
        raw-body scope (signature verified over exact bytes; not under /api auth — the
        signature is the auth); graceful 501s when unconfigured
  - [x] /api/public/config.billingEnabled + status.auth.billing {enabled,hasAccount,periodEnd}
  - [x] BillingPage: live checkout/portal buttons, checkout=success/canceled banners,
        trial countdown, inactive-plan reactivation prompt, unconfigured explainer
  - [x] billing.test.ts: signature rejection, lifecycle sync matrix, customer-id fallback,
        paywall integration — 60 tests green
  - Elwin setup needed later (SAAS_SETUP.md in P7): Stripe products/prices, webhook endpoint,
    STRIPE_* + APP_URL envs
- [x] **Phase 6 — Landing, admin** (2026-07-19)
  - [x] Public landing at "/" (supabase mode, signed out): telecom-manual marketing page —
        hero with a self-typing call-ticket demo (deterministic elapsed-time animation,
        reduced-motion static), numbered go-live steps, equipment board, pricing grid from
        /api/public/config, CTAs → /signup. Verified full-page in browser.
  - [x] /api/admin/tenants (+ /suspend /reactivate w/ subaccount status change), 404-hidden
        from non-admins; AdminPage table + Tenants nav for platform admins; admin test in
        tenancy.test.ts — 61 tests green
  - [x] onboarding: existing empty-state + per-tenant seed demo covers first-run
  - Note: browser-pane scroll+screenshot wedges on long pages (tool quirk, not app) —
    verify tall pages via viewport resize instead
- [x] **Phase 7 — Docs, security sweep, verify** (2026-07-19)
  - [x] SAAS_SETUP.md (Supabase + Stripe setup, env reference, migration path for the current
        Beelink deploy, go-live checklist, security model, scaling path)
  - [x] README two-shapes rewrite + SaaS section; DEPLOY.md SaaS note; .env.example complete
  - [x] security sweep fix: number/attach now 409s on numbers mapped to another tenant
        (was an unhandled UNIQUE violation; same-tenant moves allowed) + isolation test
  - [x] final verify: 62 tests, typecheck both workspaces, production build, browser e2e
        (landing, auth gates, console, usage, admin, fake call, SSE chat)

## Notes / decisions log

- 2026-07-19: Kicked off. Baseline: `npm test` green before changes (verify at branch point).
- DASHBOARD_TOKEN is kept as a platform-admin bearer (ops/back-compat with current deploy).
- Legacy businesses (tenant_id NULL) adopted by first ADMIN_EMAILS user's tenant.
- 2026-07-20 (follow-up session):
  - Google OAuth sign-in added to login/signup (supabase.auth.signInWithOAuth; no server
    change — JWT verify already provider-agnostic). SAAS_SETUP.md §1 gained a Google setup
    subsection + go-live item; user configured & verified the provider live.
  - Brand refresh: voice-waveform BrandMark component replaces the dot-lamp CSS mark across
    landing/auth/console; favicon updated to match.
  - Dedicated admin.test.ts (6 tests: 404 gate, roster, suspend→inactive, reactivate, unknown
    id) — the P6 admin coverage previously lived only as one case in tenancy.test.ts.
  - Test hygiene: config.ts loads repo-root .env for any unset var, so tests that don't pin
    SUPABASE_URL="" inherited the developer's real .env once Supabase was configured —
    integration.test.ts broke (open-mode seed-demo). Pinned auth env in integration + security
    tests to make the suite hermetic.
  - DEPLOY.md corrected: env table + Part 2 login step + checklist rewritten for supabase auth
    (were still describing the legacy DASHBOARD_TOKEN gate).
  - Verify: 68 tests green, typecheck both workspaces, production build clean.
