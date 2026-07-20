# Deploying CallCatcher

Split deployment: the **API server** runs on your Beelink (behind a Cloudflare Tunnel), and the
**dashboard** deploys to Vercel as a static site pointed at the tunnel's URL.

> **SaaS mode (the multi-tenant product).** The deployment mechanics below are unchanged, but
> before you start do the one-time account setup in **[SAAS_SETUP.md](SAAS_SETUP.md)** — Supabase
> project + Google OAuth, Stripe products + webhook — and have those values ready for the
> Beelink's `.env`. Two notes specific to SaaS mode:
>
> - Setting `SUPABASE_URL` switches auth from the legacy `DASHBOARD_TOKEN` gate to Supabase
>   login (email + Google). Agencies sign up and log in; `DASHBOARD_TOKEN` becomes an
>   ops/break-glass bearer you keep for yourself.
> - The **only** Vercel env the dashboard needs is `VITE_API_BASE_URL` (Part 2 §3). Supabase
>   keys are *not* set on Vercel — the dashboard fetches them from `/api/public/config` at
>   runtime. Point a Stripe webhook at `https://catcher.yourdomain.com/stripe/webhook`.

```
Browser ⇄ Vercel (dashboard, static)
             │  every /api call goes here ⬇
Twilio  ⇄ Cloudflare Tunnel ⇄ Beelink :8787 (CallCatcher server, pm2, SQLite)
```

---

## Part 1 — Beelink: run the API server

### 1. Prerequisites

```bash
node --version   # need >=20; install via nvm if missing
git --version
```

Install `cloudflared` and `pm2` if you don't already have them:

```bash
brew install cloudflare/cloudflare/cloudflared   # or the Linux equivalent for your Beelink's OS
npm install -g pm2
```

### 2. Clone and install

```bash
git clone https://github.com/ebeetles/CallCatcher.git
cd CallCatcher
npm install
```

You only need the **server** to run here — the dashboard is built and deployed separately by
Vercel (Part 2). You do *not* need to run `npm run build` on the Beelink.

### 3. Configure `.env`

```bash
cp .env.example .env
```

Edit `server`'s `.env` (repo root) and fill in:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key — powers live call reasoning + the factory |
| `DEEPGRAM_API_KEY` | your key — STT + default TTS |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `PUBLIC_URL` | the Cloudflare Tunnel URL, e.g. `https://catcher.yourdomain.com` (set this **after** step 5, then restart) |
| `DASHBOARD_TOKEN` | **required** — generate with `openssl rand -hex 24`. In SaaS mode this is your ops/break-glass bearer; setting it also silences the startup warning. |
| `ALLOWED_ORIGINS` | your Vercel dashboard URL, e.g. `https://callcatcher.vercel.app` (comma-separate if you add a custom domain later) |

**SaaS mode also needs** (full details + how to obtain each in [SAAS_SETUP.md](SAAS_SETUP.md)):

| Key | Value |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | your Supabase project — turns on multi-tenant login |
| `ADMIN_EMAILS` | your email(s), comma-separated — become platform admins on signup |
| `SECRETS_KEY` | `openssl rand -hex 32` — **required**; encrypts tenant Twilio subaccount tokens at rest |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_*` | billing (leave empty to run without billing; plans still enforced, checkout disabled) |
| `APP_URL` | dashboard origin for Stripe redirects, e.g. `https://callcatcher.vercel.app` |

Leave `PORT` at the default (`8787`) unless something else on the Beelink uses it.

> ⚠️ The server prints a warning at startup if `PUBLIC_URL` is set without `DASHBOARD_TOKEN`.
> In legacy token mode `DASHBOARD_TOKEN` is the *only* thing protecting the API — never skip it.
> In SaaS mode the Supabase JWT protects every `/api` route, but you should still set
> `DASHBOARD_TOKEN` (ops access) and `ALLOWED_ORIGINS` (browser origin allowlist).

### 4. Run it under pm2

```bash
cd CallCatcher
pm2 start "npm run start -w server" --name callcatcher-api
pm2 save
pm2 startup   # follow the printed instructions to survive reboots
```

Check it's alive:

```bash
pm2 logs callcatcher-api --lines 30
curl -s http://127.0.0.1:8787/api/status -H "authorization: Bearer <your DASHBOARD_TOKEN>"
```

### 5. Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create callcatcher
cloudflared tunnel route dns callcatcher catcher.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: callcatcher
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: catcher.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
```

Run it as a service so it survives reboots:

```bash
sudo cloudflared service install
sudo cloudflared service start
# or, if not using the system service:
pm2 start "cloudflared tunnel run callcatcher" --name callcatcher-tunnel
pm2 save
```

Now update `.env`: set `PUBLIC_URL=https://catcher.yourdomain.com`, then:

```bash
pm2 restart callcatcher-api
```

Verify from any machine:

```bash
curl -s https://catcher.yourdomain.com/api/status -H "authorization: Bearer <your DASHBOARD_TOKEN>"
```

---

## Part 2 — Vercel: deploy the dashboard

### 1. Import the project

In the Vercel dashboard: **Add New → Project → import `ebeetles/CallCatcher`**.

### 2. Configure the build

Vercel needs to know the dashboard lives in `web/`:

- **Root Directory**: `web`
- **Build Command**: `npm run build` (auto-detected)
- **Output Directory**: `dist` (auto-detected)
- **Install Command**: leave default (`npm install`) — it only installs `web`'s deps since
  Root Directory is scoped there

### 3. Environment variable

Add one env var (Project Settings → Environment Variables):

```
VITE_API_BASE_URL = https://catcher.yourdomain.com
```

This must be set **before** the build — Vite bakes it into the static bundle at build time, it's
not read at runtime. If you change the Beelink's tunnel URL later, update this and redeploy.

### 4. Deploy

Push to `main` (or click Deploy). Once live, open the Vercel URL:

- **SaaS mode** (`SUPABASE_URL` set): you land on the marketing landing page with sign-in /
  sign-up. Create your account with an email listed in `ADMIN_EMAILS` to get platform-admin
  rights (the **Tenants** admin view). Google sign-in also needs its production redirect URL
  added in Supabase + Google — see [SAAS_SETUP.md](SAAS_SETUP.md).
- **Legacy token mode** (no `SUPABASE_URL`): you get the "Access token required" gate — paste
  the Beelink's `DASHBOARD_TOKEN` to unlock.

---

## Part 3 — point Twilio at it

Once both sides are live, buy/attach a number from the dashboard's **Overview → Phone line**
tab as usual — CallCatcher configures the Twilio voice webhook
(`https://catcher.yourdomain.com/twilio/voice`) automatically. No manual Twilio console steps
needed.

---

## After deploy: sanity checklist

- [ ] `curl https://catcher.yourdomain.com/api/status` without auth → `401`
- [ ] `curl https://catcher.yourdomain.com/api/public/config` → `200` with `"authMode":"supabase"`
- [ ] Vercel dashboard loads the landing page; sign-up / login (email + Google) works
- [ ] Your `ADMIN_EMAILS` account sees the **Tenants** admin view
- [ ] Stripe test checkout completes and the tenant's plan flips (webhook reached the Beelink)
- [ ] A business's phone line shows "Webhook configured" pointing at your tunnel URL
- [ ] `npm run fake-call -w server` from the Beelink still works locally (sanity check the
      server itself, independent of the tunnel/Vercel)
- [ ] Place one real test call to the provisioned number

## Updating later

```bash
# Beelink
cd CallCatcher && git pull && npm install && pm2 restart callcatcher-api

# Dashboard — just push to main; Vercel redeploys automatically
```
