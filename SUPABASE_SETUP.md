# Supabase Setup Guide — Admin CMS

This document contains everything you need to set up the Supabase database that powers the Admin CMS (Site Settings, Content Blocks, AI Assistant, and Revision History).

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

## Step 3 — Run the SQL Migrations

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Supabase is not configured" error | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel env vars, then Redeploy |
| `GET /api/v2-vehicles` returns only `vehicle_id` | The `data` column is empty in Supabase. Run migration `0002_seed_fleet_vehicles.sql` in the Supabase SQL Editor to upsert the correct vehicle data |
| CMS loads but shows no data | Run the SQL migrations in Step 3, then reload the CMS |
| AI assistant shows "not available" | Add `OPENAI_API_KEY` in Vercel env vars, then Redeploy |
| Public site still shows old content | Content is cached for 60s. Wait a minute and hard-refresh, or clear CDN cache |
| 401 Unauthorized error | Make sure the `ADMIN_SECRET` in Vercel matches what you type in the login screen |
| Rollback fails "no before snapshot" | That revision was an initial create — there is no "before" state to roll back to |
