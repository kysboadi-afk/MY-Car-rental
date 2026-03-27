-- =============================================================================
-- SLY RIDES — COMPLETE SUPABASE SETUP (ONE-SHOT SCRIPT)
-- =============================================================================
--
-- HOW TO USE
-- ----------
-- 1. Open your Supabase project → SQL Editor → New Query
-- 2. Paste this ENTIRE file and click Run
-- 3. That's it. Every table, index, trigger, view, and seed row is created.
--    Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT guards.
--
-- TABLES CREATED
-- --------------
--   vehicles               — fleet vehicles (vehicle editor, admin panel)
--   protection_plans       — DPP coverage tiers (admin configurable)
--   system_settings        — pricing, tax-rate, automation toggles
--   revenue_records        — per-booking revenue ledger
--   expenses               — vehicle expense tracking
--   customers              — customer profiles / ban / flag
--   booking_status_history — audit trail for status changes
--   payment_transactions   — additive payment layer
--   sms_template_overrides — custom SMS message templates
--   site_settings          — site-wide CMS settings (name, hero text, etc.)
--   content_blocks         — FAQs, announcements, testimonials
--   content_revisions      — revision history for CMS changes
--
-- VIEWS CREATED
-- -------------
--   vehicle_revenue_summary — per-vehicle revenue aggregation
--
-- =============================================================================


-- =============================================================================
-- 1. VEHICLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id  text        PRIMARY KEY,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicles_updated_at_idx ON vehicles (updated_at);

-- Seed the three fleet vehicles (safe to re-run — ignores conflicts)
INSERT INTO vehicles (vehicle_id, data) VALUES
  ('slingshot',  '{"vehicle_id":"slingshot",  "vehicle_name":"Slingshot R",   "type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/slingshot.jpg"}'::jsonb),
  ('camry',      '{"vehicle_id":"camry",      "vehicle_name":"Camry 2012",    "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/IMG_0046.png"}'::jsonb),
  ('camry2013',  '{"vehicle_id":"camry2013",  "vehicle_name":"Camry 2013 SE", "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/IMG_5144.png"}'::jsonb)
ON CONFLICT (vehicle_id) DO UPDATE
  SET data = excluded.data
  WHERE vehicles.data = '{}'::jsonb OR vehicles.data IS NULL;

-- Remove legacy extra Slingshot units if they were seeded previously
DELETE FROM vehicles WHERE vehicle_id IN ('slingshot2', 'slingshot3');


-- =============================================================================
-- 2. PROTECTION PLANS
-- =============================================================================

CREATE TABLE IF NOT EXISTS protection_plans (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  description   text,
  daily_rate    numeric(10,2) NOT NULL DEFAULT 0,
  liability_cap numeric(10,2) DEFAULT 1000,
  is_active     boolean     DEFAULT true,
  sort_order    integer     DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed default tiers (only when table is empty)
INSERT INTO protection_plans (name, description, daily_rate, liability_cap, is_active, sort_order)
SELECT * FROM (VALUES
  ('None',     'No protection plan selected',          0::numeric,  0::numeric,    true, 0),
  ('Basic',    'Basic damage protection, $1,000 cap',  15::numeric, 1000::numeric, true, 1),
  ('Standard', 'Standard coverage, $500 cap',          25::numeric, 500::numeric,  true, 2),
  ('Premium',  'Full coverage, $0 liability',          40::numeric, 0::numeric,    true, 3)
) AS v(name, description, daily_rate, liability_cap, is_active, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM protection_plans);


-- =============================================================================
-- 3. SYSTEM SETTINGS  (pricing, tax, automation toggles)
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_settings (
  key         text  PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT 'null'::jsonb,
  description text,
  category    text  DEFAULT 'general',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

INSERT INTO system_settings (key, value, description, category) VALUES
  ('la_tax_rate',                  '0.1025',  'Los Angeles combined sales tax rate',             'tax'),
  ('slingshot_daily_rate',         '350',     'Slingshot R daily rate (USD)',                    'pricing'),
  ('camry_daily_rate',             '55',      'Camry daily rate (USD)',                          'pricing'),
  ('camry_weekly_rate',            '350',     'Camry weekly rate (USD)',                         'pricing'),
  ('camry_biweekly_rate',          '650',     'Camry bi-weekly rate (USD)',                      'pricing'),
  ('camry_monthly_rate',           '1300',    'Camry monthly rate (USD)',                        'pricing'),
  ('slingshot_security_deposit',   '150',     'Slingshot refundable security deposit (USD)',     'pricing'),
  ('slingshot_booking_deposit',    '50',      'Slingshot non-refundable booking deposit',        'pricing'),
  ('auto_block_dates_on_approve',  'true',    'Auto-block vehicle dates when booking approved',  'automation'),
  ('auto_create_revenue_on_pay',   'true',    'Auto-create revenue record when payment received','automation'),
  ('auto_update_customer_stats',   'true',    'Auto-update customer stats on booking events',    'automation'),
  ('notify_sms_on_approve',        'true',    'Send SMS to customer when booking approved',      'notification'),
  ('notify_email_on_approve',      'true',    'Send email to customer when booking approved',    'notification'),
  ('overdue_grace_period_hours',   '2',       'Hours after return time before booking flagged overdue','automation')
ON CONFLICT (key) DO NOTHING;


-- =============================================================================
-- 4. REVENUE RECORDS
-- =============================================================================

CREATE TABLE IF NOT EXISTS revenue_records (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        text        NOT NULL,
  vehicle_id        text        NOT NULL,
  customer_name     text,
  customer_phone    text,
  customer_email    text,
  pickup_date       date,
  return_date       date,
  gross_amount      numeric(10,2) NOT NULL DEFAULT 0,
  deposit_amount    numeric(10,2) NOT NULL DEFAULT 0,
  refund_amount     numeric(10,2) NOT NULL DEFAULT 0,
  net_amount        numeric(10,2) GENERATED ALWAYS AS (gross_amount - refund_amount) STORED,
  payment_method    text        DEFAULT 'stripe',
  payment_status    text        DEFAULT 'pending',
  protection_plan_id uuid,
  notes             text,
  is_no_show        boolean     DEFAULT false,
  is_cancelled      boolean     DEFAULT false,
  override_by_admin boolean     DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_records_booking_id_idx    ON revenue_records (booking_id);
CREATE INDEX IF NOT EXISTS revenue_records_vehicle_id_idx    ON revenue_records (vehicle_id);
CREATE INDEX IF NOT EXISTS revenue_records_payment_status_idx ON revenue_records (payment_status);
CREATE INDEX IF NOT EXISTS revenue_records_created_at_idx    ON revenue_records (created_at);

-- Unique constraint on booking_id (safe to add even if table pre-exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'revenue_records'
      AND constraint_name = 'revenue_records_booking_id_unique'
      AND constraint_type = 'UNIQUE'
  ) THEN
    -- Remove duplicates first (keeps oldest row per booking_id)
    DELETE FROM revenue_records
    WHERE id NOT IN (
      SELECT DISTINCT ON (booking_id) id
      FROM revenue_records
      ORDER BY booking_id, created_at ASC
    );
    ALTER TABLE revenue_records ADD CONSTRAINT revenue_records_booking_id_unique UNIQUE (booking_id);
  END IF;
END $$;

-- Seed real 2026 revenue records
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date, gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status, notes, override_by_admin
) VALUES
  ('bk-da-2026-0321', 'camry2013', 'David Agbebaku', '+13463814616', 'davosama15@gmail.com',
   '2026-03-21', '2026-03-28', 479.59, 0, 0, 'stripe', 'paid', '7-day rental', true),
  ('bk-ms-2026-0313', 'camry',     'Mariatu Sillah',  '+12137296017', 'marysillah23@gamil.com',
   '2026-03-13', '2026-03-17', 200.00, 0, 0, 'cash',   'paid', '4-day rental', true),
  ('bk-bg-2026-0219', 'camry',     'Bernard Gilot',   '+14075586386', 'gilot42@gmail.com',
   '2026-02-19', '2026-03-02', 785.00, 0, 300.00, 'cash', 'partial', '11-day rental — $300 refunded (car broke down)', true)
ON CONFLICT (booking_id) DO NOTHING;


-- =============================================================================
-- 5. EXPENSES
-- =============================================================================

CREATE TABLE IF NOT EXISTS expenses (
  expense_id  text          PRIMARY KEY,
  vehicle_id  text          NOT NULL,
  date        date          NOT NULL,
  category    text          NOT NULL
                            CHECK (category IN ('maintenance','insurance','repair','fuel','registration','other')),
  amount      numeric(10,2) NOT NULL CHECK (amount > 0),
  notes       text          NOT NULL DEFAULT '',
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expenses_vehicle_id_idx ON expenses (vehicle_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx       ON expenses (date DESC);


-- =============================================================================
-- 6. CUSTOMERS
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text        NOT NULL,
  phone              text,
  email              text,
  flagged            boolean     DEFAULT false,
  banned             boolean     DEFAULT false,
  flag_reason        text,
  ban_reason         text,
  total_bookings     integer     DEFAULT 0,
  total_spent        numeric(10,2) DEFAULT 0,
  first_booking_date date,
  last_booking_date  date,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone)
  WHERE phone IS NOT NULL AND phone != '';
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (email)
  WHERE email IS NOT NULL AND email != '';
CREATE INDEX IF NOT EXISTS customers_banned_idx ON customers (banned);

-- Seed real customers
INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
VALUES
  ('David Agbebaku', '+13463814616', 'davosama15@gmail.com',   1, 479.59, '2026-03-21', '2026-03-28'),
  ('Mariatu Sillah', '+12137296017', 'marysillah23@gamil.com', 1, 200.00, '2026-03-13', '2026-03-17'),
  ('Bernard Gilot',  '+14075586386', 'gilot42@gmail.com',      1, 485.00, '2026-02-19', '2026-03-02')
ON CONFLICT (phone) DO UPDATE
  SET
    name               = EXCLUDED.name,
    email              = EXCLUDED.email,
    total_bookings     = EXCLUDED.total_bookings,
    total_spent        = EXCLUDED.total_spent,
    first_booking_date = EXCLUDED.first_booking_date,
    last_booking_date  = EXCLUDED.last_booking_date,
    updated_at         = now();


-- =============================================================================
-- 7. BOOKING STATUS HISTORY  (audit trail)
-- =============================================================================

CREATE TABLE IF NOT EXISTS booking_status_history (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text        NOT NULL,
  vehicle_id text,
  old_status text,
  new_status text        NOT NULL,
  changed_by text        DEFAULT 'admin',
  notes      text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bsh_booking_id_idx ON booking_status_history (booking_id);
CREATE INDEX IF NOT EXISTS bsh_changed_at_idx ON booking_status_history (changed_at);


-- =============================================================================
-- 8. PAYMENT TRANSACTIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id               text          NOT NULL,
  vehicle_id               text,
  amount                   numeric(10,2) NOT NULL,
  transaction_type         text          NOT NULL,
  payment_method           text          DEFAULT 'stripe',
  payment_status           text          DEFAULT 'pending',
  stripe_payment_intent_id text,
  stripe_refund_id         text,
  notes                    text,
  processed_by             text          DEFAULT 'system',
  created_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pt_booking_id_idx ON payment_transactions (booking_id);
CREATE INDEX IF NOT EXISTS pt_vehicle_id_idx ON payment_transactions (vehicle_id);
CREATE INDEX IF NOT EXISTS pt_created_at_idx ON payment_transactions (created_at);


-- =============================================================================
-- 9. SMS TEMPLATE OVERRIDES
-- =============================================================================

CREATE TABLE IF NOT EXISTS sms_template_overrides (
  template_key  text        PRIMARY KEY,
  message       text,
  enabled       boolean     NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);


-- =============================================================================
-- 10. SITE SETTINGS  (Admin CMS — business name, hero text, etc.)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.site_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_settings_key ON public.site_settings (key);

-- Seed default site settings
INSERT INTO public.site_settings (key, value) VALUES
  ('business_name',        'SLY Transportation Services'),
  ('phone',                ''),
  ('whatsapp',             ''),
  ('email',                ''),
  ('instagram_url',        ''),
  ('facebook_url',         ''),
  ('tiktok_url',           ''),
  ('twitter_url',          ''),
  ('promo_banner_enabled', 'false'),
  ('promo_banner_text',    ''),
  ('hero_title',           'Explore LA in Style'),
  ('hero_subtitle',        'Affordable car rentals in Los Angeles'),
  ('about_text',           ''),
  ('policies_cancellation',''),
  ('policies_damage',      ''),
  ('policies_fuel',        ''),
  ('policies_age',         ''),
  ('service_area_notes',   ''),
  ('pickup_instructions',  '')
ON CONFLICT (key) DO NOTHING;


-- =============================================================================
-- 11. CONTENT BLOCKS  (FAQs, announcements, testimonials)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.content_blocks (
  block_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL CHECK (type IN ('faq', 'announcement', 'testimonial')),
  title           TEXT,
  body            TEXT,
  author_name     TEXT,
  author_location TEXT,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_type   ON public.content_blocks (type);
CREATE INDEX IF NOT EXISTS idx_content_blocks_active ON public.content_blocks (active);
CREATE INDEX IF NOT EXISTS idx_content_blocks_sort   ON public.content_blocks (sort_order, created_at);

-- Seed starter FAQ content blocks (only if table is empty)
INSERT INTO public.content_blocks (type, title, body, sort_order, active)
SELECT type, title, body, sort_order, active FROM (VALUES
  ('faq', 'What is the minimum rental age?',    'The minimum age to rent is 21 years old. A valid driver''s license is required.', 1, true),
  ('faq', 'Do you offer airport pickup?',        'Yes, we offer pickup and drop-off at major LA area airports. Please contact us to arrange.', 2, true),
  ('faq', 'What forms of payment do you accept?','We accept all major credit cards via Stripe. Payments are processed securely online.', 3, true),
  ('faq', 'Is there a security deposit?',        'The Slingshot requires a $150 refundable security deposit collected at pickup. The Camry has no deposit.', 4, true)
) AS v(type, title, body, sort_order, active)
WHERE NOT EXISTS (SELECT 1 FROM public.content_blocks);


-- =============================================================================
-- 12. CONTENT REVISIONS  (Admin CMS revision history / rollback)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.content_revisions (
  id            BIGSERIAL   PRIMARY KEY,
  resource_type TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL,
  before        JSONB,
  after         JSONB,
  changed_keys  TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_revisions_resource
  ON public.content_revisions (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_content_revisions_created
  ON public.content_revisions (created_at DESC);


-- =============================================================================
-- 13. VIEW — vehicle_revenue_summary
-- =============================================================================

CREATE OR REPLACE VIEW vehicle_revenue_summary AS
SELECT
  vehicle_id,
  COUNT(*) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS booking_count,
  COUNT(*) FILTER (WHERE is_cancelled)                        AS cancelled_count,
  COUNT(*) FILTER (WHERE is_no_show)                          AS no_show_count,
  SUM(gross_amount)  FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_gross,
  SUM(refund_amount)                                                      AS total_refunds,
  SUM(net_amount)    FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_net,
  SUM(deposit_amount) FILTER (WHERE NOT is_cancelled)                    AS total_deposits,
  MAX(return_date)  AS last_return_date,
  MIN(pickup_date)  AS first_pickup_date
FROM revenue_records
GROUP BY vehicle_id;


-- =============================================================================
-- 14. AUTO-UPDATE updated_at TRIGGER FUNCTION
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Attach trigger to every table that has an updated_at column
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'revenue_records',
    'protection_plans',
    'customers',
    'system_settings',
    'content_blocks',
    'site_settings',
    'sms_template_overrides'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = tbl || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
        tbl || '_updated_at', tbl
      );
    END IF;
  END LOOP;
END $$;


-- =============================================================================
-- DONE
-- All 12 tables, 1 view, and all triggers are now in place.
-- You can run this script again at any time — it is fully idempotent.
-- (Corresponds to migrations 0001 – 0010)
-- =============================================================================


-- =============================================================================
-- 15. VEHICLE IMAGE STORAGE BUCKET
-- =============================================================================
-- Creates a public Supabase Storage bucket called "vehicle-images" so the admin
-- panel can upload vehicle photos directly from the Edit/Add Vehicle modal.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-images',
  'vehicle-images',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public             = true,
      file_size_limit    = 5242880,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif'];

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vehicle-images: public read"   ON storage.objects;
DROP POLICY IF EXISTS "vehicle-images: service write" ON storage.objects;

CREATE POLICY "vehicle-images: public read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'vehicle-images');

CREATE POLICY "vehicle-images: service write"
  ON storage.objects
  FOR ALL
  USING     (bucket_id = 'vehicle-images' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'vehicle-images' AND auth.role() = 'service_role');


-- =============================================================================
-- 16. ENSURE VEHICLE NAMES IN JSONB DATA
-- =============================================================================
-- (Migration 0012) — Patches any vehicle rows where vehicle_name is missing or
-- empty inside the JSONB data column.  Safe to re-run.

UPDATE vehicles
SET   data = jsonb_set(data, '{vehicle_name}', to_jsonb('Slingshot R'::text)), updated_at = now()
WHERE vehicle_id = 'slingshot'   AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');

UPDATE vehicles
SET   data = jsonb_set(data, '{vehicle_name}', to_jsonb('Camry 2012'::text)), updated_at = now()
WHERE vehicle_id = 'camry'       AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');

UPDATE vehicles
SET   data = jsonb_set(data, '{vehicle_name}', to_jsonb('Camry 2013 SE'::text)), updated_at = now()
WHERE vehicle_id = 'camry2013'   AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');


-- =============================================================================
-- 17. RENTAL MANAGEMENT BACKEND
-- =============================================================================
-- (Migration 0014) — Adds normalized columns to vehicles/customers, creates
-- bookings, payments, blocked_dates, revenue tables, and PG triggers.
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT guards.

-- ── 17a. Normalized vehicle columns ──────────────────────────────────────────
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_name   text;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type   text;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS daily_price    numeric(10,2);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS deposit_amount numeric(10,2);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_status  text DEFAULT 'available';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS mileage        numeric(10,0) DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS created_at     timestamptz   DEFAULT now();

DO $$
BEGIN
  ALTER TABLE vehicles ADD CONSTRAINT vehicles_rental_status_check
    CHECK (rental_status IN ('available', 'rented', 'maintenance'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE vehicles SET
  vehicle_name   = COALESCE(vehicle_name,   data->>'vehicle_name'),
  vehicle_type   = COALESCE(vehicle_type,   data->>'type'),
  daily_price    = COALESCE(daily_price,    CASE
    WHEN vehicle_id IN ('slingshot','slingshot2','slingshot3') THEN 350
    WHEN vehicle_id IN ('camry','camry2013')                   THEN  55
    ELSE 0
  END),
  deposit_amount = COALESCE(deposit_amount, CASE
    WHEN vehicle_id IN ('slingshot','slingshot2','slingshot3') THEN 150
    ELSE 0
  END),
  rental_status  = COALESCE(rental_status, 'available'),
  mileage        = COALESCE(mileage, 0),
  created_at     = COALESCE(created_at, now())
WHERE vehicle_name IS NULL OR vehicle_type IS NULL OR daily_price IS NULL;

-- ── 17b. Normalized customer columns ─────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS full_name      text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS driver_license text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS risk_flag      text DEFAULT 'low';

DO $$
BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_risk_flag_check
    CHECK (risk_flag IN ('low', 'medium', 'high'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE customers SET
  full_name = COALESCE(full_name, name),
  risk_flag = CASE
    WHEN risk_flag IS NOT NULL AND risk_flag NOT IN ('low') THEN risk_flag
    WHEN banned  = true THEN 'high'
    WHEN flagged = true THEN 'medium'
    ELSE 'low'
  END
WHERE full_name IS NULL
   OR (risk_flag = 'low' AND (flagged = true OR banned = true));

-- ── 17c. bookings table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref       text          UNIQUE,
  customer_id       uuid          REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id        text          REFERENCES vehicles(vehicle_id) ON DELETE RESTRICT,
  pickup_date       date,
  return_date       date,
  pickup_time       time,
  return_time       time,
  status            text          NOT NULL DEFAULT 'pending',
  total_price       numeric(10,2) NOT NULL DEFAULT 0,
  deposit_paid      numeric(10,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(10,2) NOT NULL DEFAULT 0,
  payment_status    text          NOT NULL DEFAULT 'unpaid',
  notes             text,
  payment_method    text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

DO $$ BEGIN ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','approved','active','completed','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid','partial','paid'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS bookings_customer_id_idx ON bookings (customer_id);
CREATE INDEX IF NOT EXISTS bookings_vehicle_id_idx  ON bookings (vehicle_id);
CREATE INDEX IF NOT EXISTS bookings_pickup_date_idx ON bookings (pickup_date);
CREATE INDEX IF NOT EXISTS bookings_return_date_idx ON bookings (return_date);
CREATE INDEX IF NOT EXISTS bookings_status_idx      ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_created_at_idx  ON bookings (created_at DESC);

DROP TRIGGER IF EXISTS bookings_updated_at ON bookings;
CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 17d. payments table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid          REFERENCES bookings(id) ON DELETE CASCADE,
  amount      numeric(10,2) NOT NULL DEFAULT 0,
  type        text          NOT NULL DEFAULT 'full',
  method      text          NOT NULL DEFAULT 'card',
  status      text          NOT NULL DEFAULT 'completed',
  notes       text,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

DO $$ BEGIN ALTER TABLE payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('deposit','full','refund'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('card','cash','zelle'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS payments_booking_id_idx ON payments (booking_id);
CREATE INDEX IF NOT EXISTS payments_created_at_idx ON payments (created_at DESC);

-- ── 17e. blocked_dates table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocked_dates (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text  REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  start_date  date  NOT NULL,
  end_date    date  NOT NULL,
  reason      text  NOT NULL DEFAULT 'manual'
);

DO $$ BEGIN ALTER TABLE blocked_dates ADD CONSTRAINT blocked_dates_reason_check
  CHECK (reason IN ('booking','maintenance','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS blocked_dates_vehicle_dates_reason_idx
  ON blocked_dates (vehicle_id, start_date, end_date, reason);
CREATE INDEX IF NOT EXISTS blocked_dates_vehicle_id_idx ON blocked_dates (vehicle_id);
CREATE INDEX IF NOT EXISTS blocked_dates_start_date_idx ON blocked_dates (start_date);

-- ── 17f. revenue table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid          UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  vehicle_id  text          REFERENCES vehicles(vehicle_id) ON DELETE RESTRICT,
  gross       numeric(10,2) NOT NULL DEFAULT 0,
  expenses    numeric(10,2) NOT NULL DEFAULT 0,
  net         numeric(10,2) GENERATED ALWAYS AS (gross - expenses) STORED,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_vehicle_id_idx ON revenue (vehicle_id);
CREATE INDEX IF NOT EXISTS revenue_created_at_idx ON revenue (created_at DESC);

-- ── 17g. Trigger functions ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_conflict_id uuid; v_blocked_vid text;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  IF NEW.pickup_date IS NULL OR NEW.return_date IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_conflict_id FROM bookings
  WHERE vehicle_id = NEW.vehicle_id AND status NOT IN ('cancelled')
    AND pickup_date <= NEW.return_date AND return_date >= NEW.pickup_date LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Booking conflict: vehicle % is already booked for % to % (conflicts with %)',
      NEW.vehicle_id, NEW.pickup_date, NEW.return_date, v_conflict_id;
  END IF;
  SELECT vehicle_id INTO v_blocked_vid FROM blocked_dates
  WHERE vehicle_id = NEW.vehicle_id AND reason != 'booking'
    AND start_date <= NEW.return_date AND end_date >= NEW.pickup_date LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Date conflict: vehicle % has blocked dates overlapping with % to %',
      NEW.vehicle_id, NEW.pickup_date, NEW.return_date;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS bookings_check_conflicts ON bookings;
CREATE TRIGGER bookings_check_conflicts
  BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION check_booking_conflicts();

CREATE OR REPLACE FUNCTION on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
    VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking')
    ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
  END IF;
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0) ON CONFLICT (booking_id) DO NOTHING;
  END IF;
  IF NEW.status = 'active' THEN
    UPDATE vehicles SET rental_status = 'rented' WHERE vehicle_id = NEW.vehicle_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS bookings_after_insert ON bookings;
CREATE TRIGGER bookings_after_insert
  AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION on_booking_create();

CREATE OR REPLACE FUNCTION on_booking_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  CASE NEW.status
    WHEN 'active' THEN
      UPDATE vehicles SET rental_status = 'rented' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'completed' THEN
      UPDATE vehicles SET rental_status = 'available' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'cancelled' THEN
      DELETE FROM blocked_dates WHERE vehicle_id = NEW.vehicle_id
        AND start_date = NEW.pickup_date AND end_date = NEW.return_date AND reason = 'booking';
      IF NEW.deposit_paid = 0 THEN DELETE FROM revenue WHERE booking_id = NEW.id; END IF;
      IF OLD.status = 'active' THEN
        UPDATE vehicles SET rental_status = 'available' WHERE vehicle_id = NEW.vehicle_id;
      END IF;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS bookings_after_status_change ON bookings;
CREATE TRIGGER bookings_after_status_change
  AFTER UPDATE OF status ON bookings FOR EACH ROW EXECUTE FUNCTION on_booking_status_change();

CREATE OR REPLACE FUNCTION on_payment_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_total numeric; v_paid numeric; v_pstatus text;
BEGIN
  SELECT total_price, deposit_paid INTO v_total, v_paid FROM bookings WHERE id = NEW.booking_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.type = 'refund' THEN v_paid := GREATEST(0, v_paid - NEW.amount);
  ELSE v_paid := v_paid + NEW.amount; END IF;
  IF v_total > 0 AND v_paid >= v_total THEN v_pstatus := 'paid';
  ELSIF v_paid > 0 THEN v_pstatus := 'partial';
  ELSE v_pstatus := 'unpaid'; END IF;
  UPDATE bookings SET deposit_paid = v_paid,
    remaining_balance = GREATEST(0, v_total - v_paid), payment_status = v_pstatus
  WHERE id = NEW.booking_id;
  IF NEW.type != 'refund' THEN
    UPDATE revenue SET gross = v_paid WHERE booking_id = NEW.booking_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS payments_after_insert ON payments;
CREATE TRIGGER payments_after_insert
  AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION on_payment_create();

-- ── 17h. Seed migrated bookings ───────────────────────────────────────────────
INSERT INTO customers (name, full_name, phone, email, risk_flag)
VALUES
  ('Mariatu Sillah', 'Mariatu Sillah', '+12137296017', 'marysillah23@gamil.com', 'low'),
  ('Bernard Gilot',  'Bernard Gilot',  '+14075586386', 'gilot42@gmail.com',      'low'),
  ('David Agbebaku', 'David Agbebaku', '+13463814616', 'davosama15@gmail.com',   'low')
ON CONFLICT (phone) DO UPDATE SET
  full_name  = COALESCE(customers.full_name,  EXCLUDED.full_name),
  email      = COALESCE(customers.email,      EXCLUDED.email),
  risk_flag  = COALESCE(customers.risk_flag,  EXCLUDED.risk_flag),
  updated_at = now();

ALTER TABLE bookings DISABLE TRIGGER bookings_check_conflicts;

INSERT INTO bookings (booking_ref, customer_id, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, total_price, deposit_paid, remaining_balance, payment_status, notes, payment_method, created_at)
SELECT 'bk-ms-2026-0313', c.id, 'camry', '2026-03-13', '2026-03-17', '11:00:00', '11:00:00', 'completed', 200.00, 200.00, 0.00, 'paid', '4-day rental', 'cash', '2026-03-12 18:00:00+00'
FROM customers c WHERE c.phone = '+12137296017' ON CONFLICT (booking_ref) DO NOTHING;

INSERT INTO bookings (booking_ref, customer_id, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, total_price, deposit_paid, remaining_balance, payment_status, notes, payment_method, created_at)
SELECT 'bk-bg-2026-0219', c.id, 'camry', '2026-02-19', '2026-03-02', '21:00:00', '21:00:00', 'completed', 485.00, 485.00, 0.00, 'paid', '$300 refunded — car broke down', 'cash', '2026-02-18 18:00:00+00'
FROM customers c WHERE c.phone = '+14075586386' ON CONFLICT (booking_ref) DO NOTHING;

INSERT INTO bookings (booking_ref, customer_id, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, total_price, deposit_paid, remaining_balance, payment_status, notes, payment_method, created_at)
SELECT 'bk-da-2026-0321', c.id, 'camry2013', '2026-03-21', '2026-03-28', '22:45:00', '05:45:00', 'active', 479.59, 479.59, 0.00, 'paid', '7-day rental', 'stripe', '2026-03-20 18:00:00+00'
FROM customers c WHERE c.phone = '+13463814616' ON CONFLICT (booking_ref) DO NOTHING;

ALTER TABLE bookings ENABLE TRIGGER bookings_check_conflicts;

INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
SELECT b.vehicle_id, b.pickup_date, b.return_date, 'booking' FROM bookings b
WHERE b.booking_ref IN ('bk-ms-2026-0313','bk-bg-2026-0219','bk-da-2026-0321') AND b.status NOT IN ('cancelled')
ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;

INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
SELECT b.id, b.vehicle_id, b.deposit_paid, 0 FROM bookings b
WHERE b.booking_ref IN ('bk-ms-2026-0313','bk-bg-2026-0219','bk-da-2026-0321') AND b.deposit_paid > 0
ON CONFLICT (booking_id) DO NOTHING;
