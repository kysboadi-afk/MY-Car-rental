# Staging Environment Setup Guide

This repository now supports a formal **staging-first** workflow, but you must provision the external projects (Supabase, Vercel, Stripe) yourself.

## 1) Provision separate staging infrastructure

- Create a dedicated **Supabase staging project**.
- Create a dedicated **Vercel staging project** (or stable staging deployment URL).
- Use **Stripe test mode only** for staging.
- Configure staging webhook endpoints for:
  - `/api/stripe-webhook`
  - `/api/stripe-identity-webhook`
  - `/api/veriff-webhook`
  - `/api/bouncie-webhook` (if used in staging validation scope)

## 2) Required environment separation

Never reuse production secrets in staging.

Set explicit environment identity in staging:

- `APP_ENV=staging`

Optional staging automation override:

- `ENABLE_STAGING_AUTOMATION=true` (only if you intentionally want scheduled GET cron jobs to run in staging)

By default, when `APP_ENV=staging`, scheduled GET automation endpoints return:

- `{"skipped":true,"reason":"staging_automation_disabled",...}`

Manual POST triggers with `ADMIN_SECRET`/`CRON_SECRET` still work.

## 3) Environment variable inventory (minimum)

Create separate **staging** and **production** values for all sensitive keys below:

- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- Identity and webhooks: `VERIFF_*`, `CHECKR_*`, `BOUNCIE_*`, `CRON_SECRET`
- Notifications: `SMTP_*`, `TEXTMAGIC_*`, `OTP_SECRET`, `OWNER_*`
- Admin/GitHub automation: `ADMIN_SECRET`, `GITHUB_TOKEN`, `GITHUB_REPO`

## 4) Migration and evidence flow

1. Apply all Supabase migrations to staging first.
2. Load only sanitized/masked test data if production-like data is needed.
3. Point staging Vercel to staging Supabase + Stripe test mode credentials.
4. Validate and retain evidence for:
   - `0178`
   - `0179`
   - `0181`
   - `0182`
   - readiness gates referenced in `0183`
5. Review evidence before any production enforcement change.

## 5) Domain, CORS, and webhook review

- Keep staging frontend/backend hostnames separate from production.
- Ensure webhook URLs in Stripe/Veriff/Bouncie point to staging endpoints (not production).
- Verify CORS allowlists reflect approved staging origins before running staging QA.

## 6) Decision gate (blocked until staging evidence is approved)

Do **not**:

- activate RLS enforcement,
- enable hard org enforcement,
- retire legacy auth.

These remain blocked until staging exists and validation evidence is reviewed.
