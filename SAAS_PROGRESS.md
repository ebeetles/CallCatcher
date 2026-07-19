# SaaS build — live progress

Plan: [SAAS_PLAN.md](SAAS_PLAN.md). Update this file as work lands; any session resumes from here.

## Status: Phase 1 in progress

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
- [ ] Phase 2 — Web auth + shell (supabase-js, login/signup/reset, AuthProvider, account menu)
- [ ] Phase 3 — Twilio subaccounts (client refactor, bootstrap creation, per-tenant webhook
      signature validation, numbers/SMS via subaccount, suspend/reactivate)
- [ ] Phase 4 — Plans + metering + enforcement (plans.ts, entitlements, usage_monthly rollup,
      /api/usage, usage page, caps: 402 + TwiML unavailable, paywall)
- [ ] Phase 5 — Stripe (checkout, portal, webhook sync, billing page, tests)
- [ ] Phase 6 — Landing page, onboarding empty-state, /admin tenants view
- [ ] Phase 7 — Docs (README, SAAS_SETUP.md, .env.example), security sweep, e2e verify

## Notes / decisions log

- 2026-07-19: Kicked off. Baseline: `npm test` green before changes (verify at branch point).
- DASHBOARD_TOKEN is kept as a platform-admin bearer (ops/back-compat with current deploy).
- Legacy businesses (tenant_id NULL) adopted by first ADMIN_EMAILS user's tenant.
