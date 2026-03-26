# Supabase Setup Guide — Admin CMS

This document contains everything you need to set up the Supabase database that powers the Admin CMS (Site Settings, Content Blocks, AI Assistant, Protection Plans, Revenue, and Revision History).

---

## ✅ PR Checklist — Confirm These Before Merging Any Supabase-Related Change

Copy this into any pull request that touches `api/`, `supabase/migrations/`, or Vercel environment variables.

### 1 — Environment variables

Confirm the following variables are set in **Vercel → Project Settings → Environment Variables** (and in your local `.env` if testing locally):

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | ✅ Yes | Your project URL, e.g. `https://kdobrxffhtsigyiwnahs.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Yes | 🔒 Secret — server-side only, never expose in frontend code |
| `ADMIN_SECRET` | ✅ Yes | Password used to log into the Admin panels |
| `GITHUB_TOKEN` | ✅ Yes | Fine-grained PAT with `contents: write` — used as fallback storage when Supabase is unavailable |
| `GITHUB_REPO` | ⚠️ Optional | Defaults to `kysboadi-afk/SLY-RIDES`; override if you fork the repo |
| `OPENAI_API_KEY` | ⚠️ Optional | Only needed for the AI assistant panel |

> ⚠️ **This project does NOT use `NEXT_PUBLIC_` prefixed variables.** All Supabase access is server-side via Vercel serverless functions. The frontend never touches Supabase directly.

After adding or changing any variable: **Vercel → Deployments → Redeploy** (required for changes to take effect).

---

### 2 — Admin authentication

This project uses a simple shared-secret model via `ADMIN_SECRET`, **not** Supabase Auth / JWT roles.

- [ ] `ADMIN_SECRET` is set in Vercel (and matches what you type on the login screen)
- [ ] `ADMIN_SECRET` is a strong, unique password (not `admin`, `password`, etc.)
- [ ] No Supabase JWT claims or `user_role` columns are needed — `_admin-auth.js` handles auth with a constant-time compare
- [ ] The `SUPABASE_SERVICE_ROLE_KEY` is **never** referenced in frontend JS files (only in `api/` serverless functions)

> The service-role key bypasses Row Level Security entirely — this is intentional because all Supabase writes go through server-side Vercel functions that gate access with `ADMIN_SECRET` before touching the database.

---

### 3 — Supabase client initialisation

The singleton client lives in `api/_supabase.js`. Confirm:

- [ ] `getSupabaseAdmin()` is the only place a Supabase client is created — all `api/` files import this helper; never call `createClient()` directly in other files
- [ ] Client is created with `auth: { persistSession: false, autoRefreshToken: false }` (correct for server-side service-role use — sessions are meaningless here)
- [ ] If you add a new API file that needs Supabase, import `getSupabaseAdmin` and check for `null` before using it:

  ```js
  import { getSupabaseAdmin } from "./_supabase.js";
  
  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your Vercel environment variables." });
  ```

---

### 4 — CORS

- [ ] Every `api/` handler checks `req.headers.origin` against `ALLOWED_ORIGINS` (`["https://www.slytrans.com", "https://slytrans.com"]`) and sets the `Access-Control-Allow-Origin` header only for those origins
- [ ] Every handler responds to `OPTIONS` pre-flight requests with `200`
- [ ] If you add a new endpoint, copy the CORS block from any existing handler (e.g. `api/v2-revenue.js` lines 85-90)
- [ ] No Supabase Edge Functions are used — CORS is handled at the Vercel function layer only

---

### 5 — Supabase query style — `.select()` after mutations

- [ ] Every `INSERT`, `UPDATE`, or `UPSERT` that needs to return the saved row chains `.select()` (and `.single()` when exactly one row is expected):

  ```js
  // ✅ Correct — returns the saved record
  const { data, error } = await sb.from("revenue_records").insert(record).select().single();
  
  // ❌ Wrong — PostgREST returns nothing without .select()
  const { error } = await sb.from("revenue_records").insert(record);
  ```

- [ ] Delete operations do **not** need `.select()` unless you want to confirm what was deleted
- [ ] All Supabase calls destructure `{ data, error }` and check `error` before using `data`

---

### 6 (Optional but recommended) — Error surfacing in Admin

- [ ] Admin-facing error messages use `adminErrorMessage(err)` from `api/_error-helpers.js` — this translates raw PostgreSQL/PostgREST codes into human-readable text without leaking internals
- [ ] Schema errors (PostgreSQL `42P01` / `42703`, PostgREST `PGRST204`) are caught with `isSchemaError(err)` and trigger the GitHub fallback path — not a fatal 500
- [ ] The Admin CMS (`admin-cms.html`) surfaces errors via the `showToast(msg, 'error')` function — if a save fails, the user sees a red toast with the error message
- [ ] The Admin panel (`admin.html`) surfaces errors via `showStatus(msg, "error")` / `showFleetMsg()` / `showProfitMsg()` — ensure new panels follow the same pattern

---

### 7 (Optional) — Logging during development

- [ ] `console.error("module action:", err)` is called in every `catch` block in `api/` files before returning a 500 response (already done in all v2 endpoints — maintain this pattern)
- [ ] `console.warn("module: reason, falling back to GitHub")` is called whenever the code silently falls back to GitHub JSON storage (already done — maintain this pattern)
- [ ] When debugging a Supabase issue locally, check **Vercel → Functions → Logs** for the `console.error` output — the raw Supabase error message and PostgreSQL error code appear there

---

## Prerequisites

1. A free Supabase account at [https://supabase.com](https://supabase.com)
2. A Supabase project created (free tier is sufficient)
3. Your Vercel project already deployed from this repository

---

## Step 1 — Get Your Supabase Keys

1. Open your Supabase project dashboard.
2. Go to **Project Settings → API**.
3. Copy these three values:

| Value | Where to find it |
|-------|-----------------|
| **Project URL** | "Project URL" field (looks like `https://xxxxxxxxxxxx.supabase.co`) |
| **anon public key** | Under "Project API keys" → `anon` `public` |
| **service_role secret key** | Under "Project API keys" → `service_role` `secret` ⚠️ Keep private! |

---

## Step 2 — Add Environment Variables to Vercel

In Vercel → Your Project → **Settings → Environment Variables**, add:

| Variable Name | Value | Notes |
|--------------|-------|-------|
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Your project URL |
| `SUPABASE_ANON_KEY` | `eyJhbGciOi…` | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi…` | 🔒 Secret — never expose in frontend code |
| `ADMIN_SECRET` | A strong password of your choosing | Used to log into the Admin CMS |
| `OPENAI_API_KEY` | `sk-…` | Optional — enables the AI assistant panel |

> **After adding any variable, go to Deployments → Redeploy** for it to take effect.

---

## Step 3 — Run the ONE-SHOT Setup Script ⚡ (Recommended)

> **This is the fastest way. One paste, one click, everything is set up.**

1. Open your Supabase project → **SQL Editor → New Query**
2. Open **`supabase/migrations/COMPLETE_SETUP.sql`** from this repository
3. Copy the **entire file contents** and paste into the SQL Editor
4. Click **Run**

That script creates **every table, index, trigger, and view** the app needs, plus seeds all default data. It is completely safe to run more than once.

**Tables created:**

| Table | Used by |
|-------|---------|
| `vehicles` | Vehicle editor, admin panel |
| `protection_plans` | DPP coverage tiers — **required for Edit/Delete to work** |
| `system_settings` | Pricing, tax rate, automation toggles |
| `revenue_records` | Revenue ledger |
| `expenses` | Vehicle expense tracking |
| `customers` | Customer profiles, ban/flag |
| `booking_status_history` | Audit trail |
| `payment_transactions` | Payment layer |
| `sms_template_overrides` | Custom SMS templates |
| `site_settings` | CMS — business name, hero text, etc. |
| `content_blocks` | FAQs, announcements, testimonials |
| `content_revisions` | Revision history / rollback |

> ✅ After running the script, **reload the Admin Panel**. Edit and Delete buttons on Protection Plans will now be enabled.

---

## Step 3 (Alternative) — Run Individual Migration Files

In your Supabase project, go to **SQL Editor → New Query**, paste each block below and click **Run**.

### 3a — `vehicles` table (required for `/api/v2-vehicles`)

Stores one row per vehicle. The `data` column holds all vehicle metadata as JSONB.
This replaces the previous `vehicles.json` GitHub file as the source of truth, eliminating
the SHA-conflict errors that caused admin vehicle saves to fail.

You can also run the canonical migration files directly:
- `supabase/migrations/0001_create_vehicles.sql` — creates the table
- `supabase/migrations/0002_seed_fleet_vehicles.sql` — removes placeholder rows and upserts correct fleet data (run this if `GET /api/v2-vehicles` returns only `vehicle_id` with no other fields)

```sql
create table if not exists vehicles (
  vehicle_id text        primary key,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists vehicles_updated_at_idx on vehicles (updated_at);

-- Seed the four known fleet vehicles (safe to re-run; ignores conflicts)
insert into vehicles (vehicle_id, data) values
  ('slingshot',  '{"vehicle_id":"slingshot",  "vehicle_name":"Slingshot R",     "type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/car2.jpg"}'::jsonb),
  ('slingshot2', '{"vehicle_id":"slingshot2", "vehicle_name":"Slingshot R (2)", "type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/car3.jpg"}'::jsonb),
  ('camry',      '{"vehicle_id":"camry",      "vehicle_name":"Camry 2012",      "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/car1.jpg"}'::jsonb),
  ('camry2013',  '{"vehicle_id":"camry2013",  "vehicle_name":"Camry 2013 SE",   "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/camry-beach-hero.png"}'::jsonb)
on conflict (vehicle_id) do nothing;
```

### 3b — `site_settings` table

Stores flat key/value pairs for site-wide settings (business name, contact info, promo banners, etc.).

```sql
CREATE TABLE IF NOT EXISTS public.site_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups (already covered by PK, but helpful for clarity)
CREATE INDEX IF NOT EXISTS idx_site_settings_key ON public.site_settings (key);

COMMENT ON TABLE public.site_settings IS 'Site-wide settings editable via the Admin CMS.';
```

### 3c — `content_blocks` table

Stores structured content blocks: FAQs, announcements, and testimonials.

```sql
CREATE TABLE IF NOT EXISTS public.content_blocks (
  block_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL CHECK (type IN ('faq', 'announcement', 'testimonial')),
  title           TEXT,
  body            TEXT,
  author_name     TEXT,          -- testimonials only
  author_location TEXT,          -- testimonials only
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,   -- announcements only; NULL = never expires
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_type   ON public.content_blocks (type);
CREATE INDEX IF NOT EXISTS idx_content_blocks_active ON public.content_blocks (active);
CREATE INDEX IF NOT EXISTS idx_content_blocks_sort   ON public.content_blocks (sort_order, created_at);

COMMENT ON TABLE public.content_blocks IS 'Structured content blocks (FAQs, announcements, testimonials) editable via the Admin CMS.';
```

### 3d — `content_revisions` table

Tracks every change made via the Admin CMS so you can roll back.

```sql
CREATE TABLE IF NOT EXISTS public.content_revisions (
  id            BIGSERIAL   PRIMARY KEY,
  resource_type TEXT        NOT NULL,  -- 'site_settings' | 'content_blocks'
  resource_id   TEXT        NOT NULL,  -- 'global' for settings, block_id for blocks
  before        JSONB,                 -- snapshot before the change (NULL for new creates)
  after         JSONB,                 -- snapshot after the change (NULL for deletes)
  changed_keys  TEXT[],               -- list of keys that changed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_revisions_resource ON public.content_revisions (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_content_revisions_created  ON public.content_revisions (created_at DESC);

COMMENT ON TABLE public.content_revisions IS 'Revision history for all Admin CMS changes. Used for rollback.';
```

---

## Step 4 — Row-Level Security (RLS) Recommendations

The API functions use the `service_role` key, which bypasses RLS. However, if you also want to use the `anon` key for public reads (e.g., via a CDN edge function), enable RLS and add read-only policies:

```sql
-- Enable RLS on all three tables
ALTER TABLE public.site_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_blocks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_revisions ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read settings and blocks (public content)
CREATE POLICY "Public read site_settings"
  ON public.site_settings FOR SELECT USING (true);

CREATE POLICY "Public read active content_blocks"
  ON public.content_blocks FOR SELECT USING (active = true);

-- Revisions are admin-only — no public read policy
-- (service_role key bypasses RLS; anon key cannot read revisions)
```

> **Note:** The API endpoints in this project use `service_role` for all operations, so RLS does not affect them. The policies above are only needed if you build additional public-facing queries that use the `anon` key directly.

---

## Step 5 — Seed Data (Optional)

Paste this into the SQL Editor to create some example content blocks:

```sql
-- Example FAQs
INSERT INTO public.content_blocks (type, title, body, sort_order, active) VALUES
  ('faq', 'What is your minimum rental age?',   'The minimum age to rent is 21 years old. A valid driver''s license is required.', 1, true),
  ('faq', 'Do you offer airport pickup?',        'Yes, we offer pickup and drop-off at major LA area airports. Please contact us to arrange.', 2, true),
  ('faq', 'What forms of payment do you accept?','We accept all major credit cards via Stripe. Payments are processed securely online.', 3, true),
  ('faq', 'Is there a security deposit?',        'The Slingshot requires a $150 refundable security deposit collected at pickup. The Camry has no deposit.', 4, true);

-- Example announcement
INSERT INTO public.content_blocks (type, title, body, sort_order, active) VALUES
  ('announcement', '🎉 Summer Special!', 'Book the Slingshot for 3 days and save 10%. Use code SUMMER24 at checkout.', 1, false);

-- Example site settings
INSERT INTO public.site_settings (key, value) VALUES
  ('business_name',        'SLY Transportation Services'),
  ('phone',                ''),
  ('email',                ''),
  ('hero_title',           'Explore LA in Style'),
  ('hero_subtitle',        'Affordable car rentals in Los Angeles'),
  ('promo_banner_enabled', 'false'),
  ('promo_banner_text',    '')
ON CONFLICT (key) DO NOTHING;
```

---

## Step 6 — Access the Admin CMS

Once your Vercel environment variables are set and redeployed:

1. Open `https://your-vercel-url.vercel.app/admin-cms.html`
2. Enter your `ADMIN_SECRET` password
3. You can now edit Site Settings, manage Content Blocks, use the AI Assistant, and view/rollback Revision History

---

## 🤖 Supabase AI Assistant — Copy-Paste Prompt

If something breaks and you need help from the **Supabase AI assistant** (the chat icon inside the SQL Editor), paste the block below word-for-word. It gives the AI full context about what the app needs.

> **How to open it:** In your Supabase project → SQL Editor → click the **✦ AI** button (top right)

---

```
I am the owner of the SLY RIDES car rental web app (slytrans.com).
My backend runs on Vercel (Node.js serverless, ES modules).
My database is this Supabase project.

The app needs the following tables and objects. Please help me check
that they all exist and are correct, and run any missing SQL to create them.

=== REQUIRED TABLES ===

1. vehicles
   - vehicle_id text PRIMARY KEY
   - data jsonb NOT NULL DEFAULT '{}'
   - updated_at timestamptz NOT NULL DEFAULT now()
   Seed rows: slingshot, slingshot2, camry, camry2013

2. protection_plans
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - name text NOT NULL UNIQUE
   - description text
   - daily_rate numeric(10,2) NOT NULL DEFAULT 0
   - liability_cap numeric(10,2) NOT NULL DEFAULT 1000
   - is_active boolean NOT NULL DEFAULT true
   - sort_order integer NOT NULL DEFAULT 0
   - updated_at timestamptz NOT NULL DEFAULT now()
   Seed rows: None ($0), Basic ($15/day, $1000 cap), Standard ($25/day, $500 cap), Premium ($40/day, $0 cap)

3. system_settings
   - key text PRIMARY KEY
   - value jsonb NOT NULL DEFAULT 'null'
   - description text
   - category text DEFAULT 'general'
   - updated_at timestamptz NOT NULL DEFAULT now()
   - updated_by text
   Seed rows: la_tax_rate (0.1025), slingshot_daily_rate (350), camry_daily_rate (55),
              camry_weekly_rate (350), camry_biweekly_rate (650), slingshot_security_deposit (150),
              automation_enabled (false), reminder_hours_before (24)

4. revenue_records
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - booking_id text NOT NULL UNIQUE
   - vehicle_id text NOT NULL
   - customer_name text, customer_phone text, customer_email text
   - pickup_date date, return_date date
   - gross_amount numeric(10,2) NOT NULL DEFAULT 0
   - deposit_amount numeric(10,2) NOT NULL DEFAULT 0
   - refund_amount numeric(10,2) NOT NULL DEFAULT 0
   - net_amount numeric(10,2) GENERATED ALWAYS AS (gross_amount - refund_amount) STORED
   - payment_status text NOT NULL DEFAULT 'pending'
     CHECK (payment_status IN ('pending','paid','partial','refunded','failed'))
   - is_cancelled boolean NOT NULL DEFAULT false
   - is_no_show boolean NOT NULL DEFAULT false
   - stripe_payment_intent_id text
   - notes text
   - created_at timestamptz NOT NULL DEFAULT now()
   - updated_at timestamptz NOT NULL DEFAULT now()

5. expenses
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - vehicle_id text NOT NULL
   - date date NOT NULL
   - category text NOT NULL
     CHECK (category IN ('maintenance','insurance','repair','fuel','registration','other'))
   - amount numeric(10,2) NOT NULL CHECK (amount > 0)
   - notes text NOT NULL DEFAULT ''
   - created_at timestamptz NOT NULL DEFAULT now()

6. customers
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - name text NOT NULL
   - phone text, email text
   - flagged boolean DEFAULT false
   - banned boolean DEFAULT false
   - flag_reason text, ban_reason text
   - total_bookings integer DEFAULT 0
   - total_spent numeric(10,2) DEFAULT 0
   - first_booking_date date, last_booking_date date
   - notes text
   - created_at timestamptz NOT NULL DEFAULT now()
   - updated_at timestamptz NOT NULL DEFAULT now()

7. booking_status_history
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - booking_id text NOT NULL
   - old_status text, new_status text NOT NULL
   - changed_by text NOT NULL DEFAULT 'system'
   - changed_at timestamptz NOT NULL DEFAULT now()
   - notes text

8. payment_transactions
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - booking_id text NOT NULL
   - vehicle_id text NOT NULL
   - type text NOT NULL CHECK (type IN ('charge','refund','deposit','balance'))
   - amount numeric(10,2) NOT NULL
   - stripe_id text
   - status text NOT NULL DEFAULT 'pending'
   - notes text
   - created_at timestamptz NOT NULL DEFAULT now()

9. sms_template_overrides
   - id text PRIMARY KEY
   - body text NOT NULL
   - updated_at timestamptz NOT NULL DEFAULT now()

10. public.site_settings
    - key text PRIMARY KEY
    - value text
    - updated_at timestamptz NOT NULL DEFAULT now()
    Seed rows: business_name, phone, email, hero_title, hero_subtitle,
               promo_banner_enabled (false), promo_banner_text

11. public.content_blocks
    - block_id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    - type text NOT NULL CHECK (type IN ('faq','announcement','testimonial'))
    - title text, body text
    - author_name text, author_location text
    - sort_order integer NOT NULL DEFAULT 0
    - active boolean NOT NULL DEFAULT true
    - expires_at timestamptz
    - created_at timestamptz NOT NULL DEFAULT now()
    - updated_at timestamptz NOT NULL DEFAULT now()

12. public.content_revisions
    - id bigserial PRIMARY KEY
    - resource_type text NOT NULL
    - resource_id text NOT NULL
    - before jsonb, after jsonb
    - changed_keys text[]
    - created_at timestamptz NOT NULL DEFAULT now()

=== REQUIRED VIEW ===

CREATE OR REPLACE VIEW vehicle_revenue_summary AS
SELECT vehicle_id,
  COUNT(*) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS booking_count,
  COUNT(*) FILTER (WHERE is_cancelled)                        AS cancelled_count,
  COUNT(*) FILTER (WHERE is_no_show)                          AS no_show_count,
  SUM(gross_amount) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_gross,
  SUM(refund_amount)                                                     AS total_refunds,
  SUM(net_amount)   FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_net,
  SUM(deposit_amount) FILTER (WHERE NOT is_cancelled)                   AS total_deposits,
  MAX(return_date) AS last_return_date,
  MIN(pickup_date) AS first_pickup_date
FROM revenue_records
GROUP BY vehicle_id;

=== REQUIRED STORAGE BUCKET ===

A public Supabase Storage bucket named "vehicle-images" must exist with:
- public = true
- file_size_limit = 5242880 (5 MB)
- allowed_mime_types = ['image/jpeg','image/png','image/webp','image/gif']
Policies needed:
- Public SELECT for everyone (bucket_id = 'vehicle-images')
- ALL operations for service_role only

=== THE PROBLEM I AM SEEING ===

[Describe your error here, e.g.:
 - "The admin panel shows a 503 / Supabase not configured error on Revenue"
 - "Protection Plans Edit button is greyed out / schema error"
 - "Vehicle images fail to upload"
 - "Customers page shows empty / sync fails"
 - "The v2-vehicles API returns vehicles with no data fields"
 - "I get a 42P01 undefined_table error in the Vercel logs"
]

Please check what exists in my schema, show me the missing pieces,
and run the SQL needed to fix the problem.
The fastest fix is usually: run the full one-shot script located at
supabase/migrations/COMPLETE_SETUP.sql in this repository — it is
fully idempotent (safe to re-run, uses IF NOT EXISTS everywhere).
```

---

### Quick reference: the most common issues and what to tell the AI

| What you see | What to paste after the prompt above |
|---|---|
| 503 "Supabase not configured" on any admin page | "I get 503 Supabase not configured. My SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Vercel. Please check if the table exists and create it if missing." |
| "Database schema error" / `42P01 undefined_table` | "I get error code 42P01 undefined_table for [table name]. Please create the missing table." |
| Protection Plans Edit/Delete buttons disabled | "The protection_plans table is missing. Please create it and seed None/Basic/Standard/Premium rows." |
| Revenue page saves nothing / 503 on create | "revenue_records table may be missing. Please create it and the vehicle_revenue_summary view." |
| Vehicle images fail to upload | "The vehicle-images storage bucket is missing or has wrong policies. Please create it." |
| `/api/v2-vehicles` returns vehicles with no fields | "The vehicles table data column is empty. Please upsert the 4 fleet seed rows." |
| Customers sync fails | "The customers table may be missing. Please create it." |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Supabase is not configured" error | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel env vars, then Redeploy. |
| Protection Plans show but Edit/Delete buttons are missing or say "Set up Supabase to edit" | The `protection_plans` table doesn't exist yet. Run `supabase/migrations/COMPLETE_SETUP.sql` in the Supabase SQL Editor, then reload the Admin Panel. |
| Clicking Edit on a Protection Plan gives "Database schema error" | Same as above — run `supabase/migrations/COMPLETE_SETUP.sql` to create all required tables. |
| `GET /api/v2-vehicles` returns only `vehicle_id` | The `data` column is empty in Supabase. Run `supabase/migrations/COMPLETE_SETUP.sql` (or just `0002_seed_fleet_vehicles.sql`) in the Supabase SQL Editor. |
| CMS loads but shows no data | Run `supabase/migrations/COMPLETE_SETUP.sql` in the Supabase SQL Editor, then reload the page |
| AI assistant shows "not available" | Add `OPENAI_API_KEY` in Vercel env vars, then Redeploy |
| Public site still shows old content | Content is cached for 60s. Wait a minute and hard-refresh, or clear CDN cache |
| 401 Unauthorized error | Make sure the `ADMIN_SECRET` in Vercel matches what you type in the login screen |
| Rollback fails "no before snapshot" | That revision was an initial create — there is no "before" state to roll back to |
