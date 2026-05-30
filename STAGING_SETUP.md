# 🧪 Staging Environment Setup (Phase 1B — Vercel Staging Runtime)

This guide walks you through creating an **isolated staging Vercel project** that is completely separate from the production project.  
No production environment variables are touched at any point.

---

## Why a separate Vercel project?

- Hard environment isolation — staging env vars can never leak into production.
- Staging uses a separate Supabase project and Stripe test-mode keys.
- Cron jobs, webhooks, and calendar writes operate on staging data only.

---

## Step 1 — Create a new Vercel project for staging

1. Go to **[https://vercel.com/dashboard](https://vercel.com/dashboard)** and sign in.
2. Click **Add New → Project**.
3. Under **Import Git Repository**, select **`kysboadi-afk/SLY-RIDES`**.
4. On the **Configure Project** screen:
   - **Project Name:** `sly-rides-staging` (or any name — this becomes your `.vercel.app` subdomain)
   - **Framework Preset:** `Other`
   - **Root Directory:** `/` (default)
   - **Build & Output Settings:** leave all fields **empty** — there is no build step
5. Click **Deploy**.

> ⚠️ The deployment will succeed but the APIs will return errors until environment variables are added in Step 2. That is expected.

---

## Step 2 — Add environment variables (staging project only)

In the **staging** project: **Settings → Environment Variables**.

Add each variable from the table below.  
**Do not open the production project at any point during this step.**

Use the `.env.staging.example` file in this repository as a checklist — it lists every variable name with a placeholder value.

### Core (required for any staging API call)

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Staging Supabase project URL — `https://<your-staging-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Staging Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔒 Staging Supabase service role key — **never expose in frontend** |
| `ADMIN_SECRET` | Staging-only admin password (e.g. `staging-admin-pw-$(openssl rand -hex 8)`) |
| `STRIPE_SECRET_KEY` | Stripe **test** secret key — starts with `sk_test_` |
| `STRIPE_PUBLISHABLE_KEY` | Stripe **test** publishable key — starts with `pk_test_` |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the staging webhook endpoint (see Step 3) |
| `OTP_SECRET` | 64-char random string — `openssl rand -hex 32` |
| `CRON_SECRET` | Any random string — protects `/api/scheduled-reminders` from external calls |

### Email (required for booking email tests)

| Variable | Value |
|---|---|
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | A staging/test sending address |
| `SMTP_PASS` | App password for that address |
| `OWNER_EMAIL` | Where staging booking alerts should go |

### SMS / OTP (required for phone verification tests)

| Variable | Value |
|---|---|
| `TEXTMAGIC_USERNAME` | TextMagic account username |
| `TEXTMAGIC_API_KEY` | TextMagic API key |
| `TEXTMAGIC_FROM` | Optional — custom SMS sender ID |

### E-signature / SignNow

| Variable | Value |
|---|---|
| `SIGNNOW_TEMPLATE_ID` | SignNow template ID (from `app.signnow.com/webapp/template/{ID}/edit`) |
| `SIGNNOW_CLIENT_ID` | SignNow OAuth client ID (recommended over static token) |
| `SIGNNOW_CLIENT_SECRET` | SignNow OAuth client secret |
| `SIGNNOW_EMAIL` | SignNow account email |
| `SIGNNOW_PASSWORD` | SignNow account password |
| `SIGNNOW_ROLE_NAME` | Optional — only if template role is not `Signer 1` |

### Calendar blocking

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT with `Contents: Read and write` on `SLY-RIDES` |
| `GITHUB_REPO` | Optional — defaults to `kysboadi-afk/SLY-RIDES` |

### AI Assistant

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | `sk-…` from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

### Auto-set by Vercel — do NOT add manually

| Variable | Notes |
|---|---|
| `VERCEL_URL` | Set automatically by Vercel on every deployment |

After adding all variables click **Save**, then:  
**Deployments → ⋯ next to the latest deployment → Redeploy**

---

## Step 3 — Configure a staging Stripe webhook

1. In Stripe Dashboard, make sure you are in **Test Mode** (toggle in the top-right).
2. Go to **Developers → Webhooks → Add endpoint**.
3. Set the endpoint URL to:
   ```
   https://<your-staging-project>.vercel.app/api/stripe-webhook
   ```
   Replace `<your-staging-project>` with the Vercel subdomain from Step 1.
4. Subscribe to these events:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `charge.refunded`
5. Click **Add endpoint**.
6. Click **Reveal** next to the signing secret and copy it.
7. Paste it into the `STRIPE_WEBHOOK_SECRET` variable you set in Step 2.
8. Redeploy the staging project again so the new value takes effect.

### Validate the webhook

After redeploy, in Stripe Dashboard → the staging endpoint, send a test delivery for `payment_intent.succeeded`.  
Confirm Stripe receives **2xx** and that Vercel function logs show **no** `signature verification failed` error.

---

## Step 4 — Verify the staging APIs

Visit these URLs to confirm the staging project is alive (replace the URL with your actual staging subdomain):

| Check | URL |
|---|---|
| Stripe config | `https://<staging>.vercel.app/api/check-signnow` |
| Fleet list | `https://<staging>.vercel.app/api/v2-vehicles` |
| Admin login | `https://<staging>.vercel.app/admin-v2/` |

---

## Step 5 — Run Supabase migrations on staging

The staging Supabase project starts empty. Apply the full schema before testing:

1. Follow the instructions in **[SUPABASE_SETUP.md](./SUPABASE_SETUP.md)** — Step 3 (SQL migrations).
2. Use the staging project's connection string, not production.

---

## Notes

- **Production Vercel project:** untouched at every step above.
- **Stripe test keys** (`sk_test_` / `pk_test_`) cannot charge real cards — safe to use freely.
- Cron jobs run on the staging project against staging Supabase only.
- GitHub calendar writes via `GITHUB_TOKEN` do write to the repo's `booked-dates.json`. If you do not want staging test bookings to appear on the live calendar, either omit `GITHUB_TOKEN` from the staging project or use a fork for staging.
