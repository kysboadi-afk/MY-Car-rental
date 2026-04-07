-- =============================================================================
-- SLY RIDES — COMPLETE SUPABASE SETUP  (v2 — All Migrations 0001-0017)
-- =============================================================================
--
-- HOW TO USE
-- ----------
-- 1. Open your Supabase project → SQL Editor → New Query
-- 2. Paste this ENTIRE file and click Run  (or share with the Supabase AI
--    Assistant and say "run this SQL exactly as written")
-- 3. That's it. Every table, index, function, trigger, view, and seed row
--    is created in the correct dependency order.
--    Safe to re-run: every statement uses IF NOT EXISTS / ON CONFLICT guards
--    or CREATE OR REPLACE — nothing is lost on a second run.
--
-- WHAT IS CREATED
-- ---------------
--   Tables (16):
--     vehicles               — fleet of 5 rental vehicles
--     protection_plans       — Damage Protection Plan tiers
--     system_settings        — pricing, tax-rate & automation flags
--     revenue_records        — per-booking revenue ledger (Finance tab)
--     expenses               — vehicle expense tracking
--     customers              — customer profiles, bans, no-show count
--     booking_status_history — audit trail for booking status changes
--     payment_transactions   — full payment audit log
--     sms_template_overrides — custom SMS message templates
--     site_settings          — CMS: business name, hero text, policies
--     content_blocks         — FAQs, announcements, testimonials
--     content_revisions      — CMS revision history
--     bookings               — normalised rental bookings (with timestamps)
--     payments               — individual payment transactions
--     blocked_dates          — vehicle availability blocks
--     revenue                — trigger-managed revenue (FK → bookings)
--
--   Views (1):
--     vehicle_revenue_summary — per-vehicle aggregated revenue for admin KPIs
--
--   Trigger functions (8):
--     update_updated_at_column      — auto-update updated_at on every row change
--     booking_datetime              — combine date+time columns for overlap math
--     check_booking_conflicts       — prevent double-bookings (datetime-aware)
--     on_booking_create             — auto blocked_dates + revenue on INSERT
--     on_booking_status_change      — vehicle rental_status sync on status UPDATE
--     on_booking_status_timestamps  — stamp activated_at / completed_at
--     on_payment_create             — recompute booking payment fields on payment
--     update_customer_no_show_count — keep no_show_count in sync with revenue_records
--
-- VEHICLE IDs (must match bookings.json and the admin portal):
--   slingshot   — Slingshot R (Unit 1)
--   slingshot2  — Slingshot R (Unit 2)
--   slingshot3  — Slingshot R (Unit 3)
--   camry       — Camry 2012
--   camry2013   — Camry 2013 SE
--
-- ENVIRONMENT VARIABLES required in Vercel:
--   SUPABASE_URL               — from Supabase project → Settings → API
--   SUPABASE_SERVICE_ROLE_KEY  — from Supabase project → Settings → API
--   ADMIN_SECRET               — any strong secret string (your admin password)
--   STRIPE_SECRET_KEY          — from Stripe dashboard
--   GITHUB_TOKEN               — GitHub PAT (repo + contents write scope)
--   GITHUB_REPO                — e.g. "kysboadi-afk/SLY-RIDES"
--   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS — email config
--   OWNER_EMAIL                — business email for reservation alerts
--   TEXTMAGIC_USERNAME / TEXTMAGIC_API_KEY — SMS via TextMagic
--
-- =============================================================================


-- =============================================================================
-- STEP 0  SHARED TRIGGER HELPER
-- Must exist before any other trigger references it.
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- STEP 1  VEHICLES
-- All 5 fleet vehicles with normalized columns.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id     text          PRIMARY KEY,
  data           jsonb         NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  vehicle_name   text,
  vehicle_type   text,
  daily_price    numeric(10,2),
  deposit_amount numeric(10,2),
  rental_status  text          DEFAULT 'available',
  mileage        numeric(10,0) DEFAULT 0,
  created_at     timestamptz   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicles_updated_at_idx ON vehicles (updated_at);

-- rental_status constraint — includes 'reserved' (migration 0015)
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_rental_status_check;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_rental_status_check
  CHECK (rental_status IN ('available', 'reserved', 'rented', 'maintenance'));

-- ── Seed all 5 fleet vehicles ─────────────────────────────────────────────────
INSERT INTO vehicles (vehicle_id, data, vehicle_name, vehicle_type, daily_price, deposit_amount, rental_status, mileage) VALUES
  ('slingshot',
   '{"vehicle_id":"slingshot","vehicle_name":"Slingshot R","type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/slingshot.jpg"}'::jsonb,
   'Slingshot R', 'slingshot', 350, 150, 'available', 0),
  ('slingshot2',
   '{"vehicle_id":"slingshot2","vehicle_name":"Slingshot R (Unit 2)","type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/slingshot.jpg"}'::jsonb,
   'Slingshot R (Unit 2)', 'slingshot', 350, 150, 'available', 0),
  ('slingshot3',
   '{"vehicle_id":"slingshot3","vehicle_name":"Slingshot R (Unit 3)","type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/slingshot.jpg"}'::jsonb,
   'Slingshot R (Unit 3)', 'slingshot', 350, 150, 'available', 0),
  ('camry',
   '{"vehicle_id":"camry","vehicle_name":"Camry 2012","type":"economy","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/IMG_0046.png"}'::jsonb,
   'Camry 2012', 'economy', 55, 0, 'available', 0),
  ('camry2013',
   '{"vehicle_id":"camry2013","vehicle_name":"Camry 2013 SE","type":"economy","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"images/IMG_5144.png"}'::jsonb,
   'Camry 2013 SE', 'economy', 55, 0, 'available', 0)
ON CONFLICT (vehicle_id) DO UPDATE
  SET vehicle_name   = EXCLUDED.vehicle_name,
      vehicle_type   = EXCLUDED.vehicle_type,
      daily_price    = COALESCE(vehicles.daily_price,    EXCLUDED.daily_price),
      deposit_amount = COALESCE(vehicles.deposit_amount, EXCLUDED.deposit_amount),
      rental_status  = COALESCE(vehicles.rental_status,  EXCLUDED.rental_status),
      data           = CASE
                         WHEN vehicles.data = '{}'::jsonb OR vehicles.data IS NULL
                         THEN EXCLUDED.data
                         ELSE vehicles.data
                       END;

-- Ensure JSONB vehicle_name is populated for all 5 vehicles
UPDATE vehicles SET data = jsonb_set(data, '{vehicle_name}', to_jsonb('Slingshot R'::text)), updated_at = now()
  WHERE vehicle_id = 'slingshot'  AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');
UPDATE vehicles SET data = jsonb_set(data, '{vehicle_name}', to_jsonb('Slingshot R (Unit 2)'::text)), updated_at = now()
  WHERE vehicle_id = 'slingshot2' AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');
UPDATE vehicles SET data = jsonb_set(data, '{vehicle_name}', to_jsonb('Slingshot R (Unit 3)'::text)), updated_at = now()
  WHERE vehicle_id = 'slingshot3' AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');
UPDATE vehicles SET data = jsonb_set(data, '{vehicle_name}', to_jsonb('Camry 2012'::text)), updated_at = now()
  WHERE vehicle_id = 'camry'      AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');
UPDATE vehicles SET data = jsonb_set(data, '{vehicle_name}', to_jsonb('Camry 2013 SE'::text)), updated_at = now()
  WHERE vehicle_id = 'camry2013'  AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');

-- Fix cover_image paths: patch any bare filenames (e.g. "camry2013.jpg") that do
-- not start with "images/" or "http" to use the correct repo-relative paths.
-- Safe to re-run; only overwrites values that are already wrong.
UPDATE vehicles
  SET data = jsonb_set(data, '{cover_image}', '"images/slingshot.jpg"'::jsonb), updated_at = now()
  WHERE vehicle_id IN ('slingshot', 'slingshot2', 'slingshot3')
    AND NOT (data->>'cover_image' LIKE 'images/%' OR data->>'cover_image' LIKE '/images/%'
          OR data->>'cover_image' LIKE 'http%'    OR data->>'cover_image' IS NULL
          OR data->>'cover_image' = '');
UPDATE vehicles
  SET data = jsonb_set(data, '{cover_image}', '"images/IMG_0046.png"'::jsonb), updated_at = now()
  WHERE vehicle_id = 'camry'
    AND NOT (data->>'cover_image' LIKE 'images/%' OR data->>'cover_image' LIKE '/images/%'
          OR data->>'cover_image' LIKE 'http%'    OR data->>'cover_image' IS NULL
          OR data->>'cover_image' = '');
UPDATE vehicles
  SET data = jsonb_set(data, '{cover_image}', '"images/IMG_5144.png"'::jsonb), updated_at = now()
  WHERE vehicle_id = 'camry2013'
    AND NOT (data->>'cover_image' LIKE 'images/%' OR data->>'cover_image' LIKE '/images/%'
          OR data->>'cover_image' LIKE 'http%'    OR data->>'cover_image' IS NULL
          OR data->>'cover_image' = '');


-- =============================================================================
-- STEP 2  PROTECTION PLANS
-- Damage Protection Plan tiers shown in the booking flow.
-- =============================================================================

CREATE TABLE IF NOT EXISTS protection_plans (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text          NOT NULL,
  description   text,
  daily_rate    numeric(10,2) NOT NULL DEFAULT 0,
  liability_cap numeric(10,2) DEFAULT 1000,
  is_active     boolean       DEFAULT true,
  sort_order    integer       DEFAULT 0,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS protection_plans_updated_at ON protection_plans;
CREATE TRIGGER protection_plans_updated_at
  BEFORE UPDATE ON protection_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed default DPP tiers (only when table is empty)
INSERT INTO protection_plans (name, description, daily_rate, liability_cap, is_active, sort_order)
SELECT * FROM (VALUES
  ('None',     'No protection plan selected',           0::numeric,    0::numeric, true, 0),
  ('Basic',    'Basic damage protection – $1,000 cap', 15::numeric, 1000::numeric, true, 1),
  ('Standard', 'Standard coverage – $500 cap',         25::numeric,  500::numeric, true, 2),
  ('Premium',  'Full coverage – $0 liability',         40::numeric,    0::numeric, true, 3)
) AS v(name, description, daily_rate, liability_cap, is_active, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM protection_plans);


-- =============================================================================
-- STEP 3  SYSTEM SETTINGS
-- All pricing and tax keys expected by api/_settings.js.
-- ON CONFLICT DO NOTHING — never overwrites admin-customised values.
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_settings (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL DEFAULT 'null'::jsonb,
  description text,
  category    text        DEFAULT 'general',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

DROP TRIGGER IF EXISTS system_settings_updated_at ON system_settings;
CREATE TRIGGER system_settings_updated_at
  BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO system_settings (key, value, description, category) VALUES
  -- Tax
  ('la_tax_rate',                 '0.1025', 'Los Angeles combined sales tax rate',                          'tax'),
  -- Camry / economy daily-weekly tiers
  ('camry_daily_rate',            '55',     'Camry daily rate (USD)',                                       'pricing'),
  ('camry_weekly_rate',           '350',    'Camry 7-day rate (USD)',                                       'pricing'),
  ('camry_biweekly_rate',         '650',    'Camry 14-day rate (USD)',                                      'pricing'),
  ('camry_monthly_rate',          '1300',   'Camry 30-day rate (USD)',                                      'pricing'),
  -- Slingshot hourly/day tiers (all 5 tiers used by api/_settings.js)
  ('slingshot_3hr_rate',          '200',    'Slingshot 3-hour tier price (USD)',                            'pricing'),
  ('slingshot_6hr_rate',          '250',    'Slingshot 6-hour tier price (USD)',                            'pricing'),
  ('slingshot_daily_rate',        '350',    'Slingshot 24-hour / 1-day tier price (USD)',                   'pricing'),
  ('slingshot_2day_rate',         '700',    'Slingshot 48-hour / 2-day tier price (USD)',                   'pricing'),
  ('slingshot_3day_rate',         '1050',   'Slingshot 72-hour / 3-day tier price (USD)',                   'pricing'),
  -- Deposits / booking fees
  ('slingshot_security_deposit',  '150',    'Slingshot refundable security deposit (USD)',                  'pricing'),
  ('slingshot_booking_deposit',   '50',     'Slingshot non-refundable booking deposit (USD)',               'pricing'),
  ('camry_booking_deposit',       '50',     'Camry non-refundable booking deposit (USD)',                   'pricing'),
  -- Automation toggles
  ('auto_block_dates_on_approve', 'true',   'Auto-block vehicle dates when booking approved',               'automation'),
  ('auto_create_revenue_on_pay',  'true',   'Auto-create revenue record when payment received',             'automation'),
  ('auto_update_customer_stats',  'true',   'Auto-update customer stats on booking events',                 'automation'),
  ('notify_sms_on_approve',       'true',   'Send SMS to customer when booking approved',                   'notification'),
  ('notify_email_on_approve',     'true',   'Send email to customer when booking approved',                 'notification'),
  ('overdue_grace_period_hours',  '2',      'Hours after return time before booking flagged overdue',       'automation')
ON CONFLICT (key) DO NOTHING;


-- =============================================================================
-- STEP 4  REVENUE RECORDS  (Finance tab — primary admin ledger)
-- =============================================================================

CREATE TABLE IF NOT EXISTS revenue_records (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         text          NOT NULL,
  vehicle_id         text          NOT NULL,
  customer_name      text,
  customer_phone     text,
  customer_email     text,
  pickup_date        date,
  return_date        date,
  gross_amount       numeric(10,2) NOT NULL DEFAULT 0,
  deposit_amount     numeric(10,2) NOT NULL DEFAULT 0,
  refund_amount      numeric(10,2) NOT NULL DEFAULT 0,
  net_amount         numeric(10,2) GENERATED ALWAYS AS (gross_amount - refund_amount) STORED,
  payment_method     text          DEFAULT 'stripe',
  payment_status     text          DEFAULT 'pending',
  protection_plan_id uuid,
  notes              text,
  is_no_show         boolean       DEFAULT false,
  is_cancelled       boolean       DEFAULT false,
  override_by_admin  boolean       DEFAULT false,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_records_booking_id_idx     ON revenue_records (booking_id);
CREATE INDEX IF NOT EXISTS revenue_records_vehicle_id_idx     ON revenue_records (vehicle_id);
CREATE INDEX IF NOT EXISTS revenue_records_payment_status_idx ON revenue_records (payment_status);
CREATE INDEX IF NOT EXISTS revenue_records_pickup_date_idx    ON revenue_records (pickup_date);
CREATE INDEX IF NOT EXISTS revenue_records_created_at_idx     ON revenue_records (created_at DESC);

-- Unique booking_id constraint (idempotent — safe even if table already has rows)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE  table_name      = 'revenue_records'
      AND  constraint_name = 'revenue_records_booking_id_unique'
      AND  constraint_type = 'UNIQUE'
  ) THEN
    -- Remove duplicates first (keep oldest per booking_id)
    DELETE FROM revenue_records
    WHERE id NOT IN (
      SELECT DISTINCT ON (booking_id) id
      FROM   revenue_records
      ORDER  BY booking_id, created_at ASC
    );
    ALTER TABLE revenue_records
      ADD CONSTRAINT revenue_records_booking_id_unique UNIQUE (booking_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS revenue_records_updated_at ON revenue_records;
CREATE TRIGGER revenue_records_updated_at
  BEFORE UPDATE ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Seed real paid bookings ───────────────────────────────────────────────────
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date, gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status, notes, override_by_admin
) VALUES
  ('bk-da-2026-0321', 'camry2013', 'David Agbebaku',  '+13463814616', 'davosama15@gmail.com',
   '2026-03-21', '2026-03-28',  479.59, 0,   0,      'stripe', 'paid',    '7-day rental',                                   true),
  ('bk-ms-2026-0313', 'camry',     'Mariatu Sillah',   '+12137296017', 'marysillah23@gmail.com',
   '2026-03-13', '2026-03-17',  200.00, 0,   0,      'cash',   'paid',    '4-day rental',                                   true),
  ('bk-bg-2026-0219', 'camry',     'Bernard Gilot',    '+14075586386', 'gilot42@gmail.com',
   '2026-02-19', '2026-03-02',  785.00, 0, 300.00,   'cash',   'partial', '11-day rental — $300 refunded (car broke down)', true)
ON CONFLICT (booking_id) DO NOTHING;


-- =============================================================================
-- STEP 5  EXPENSES
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
-- STEP 6  CUSTOMERS
-- Includes all columns from migrations 0014 (full_name, driver_license, risk_flag)
-- and 0016 (no_show_count).
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text          NOT NULL,
  phone              text,
  email              text,
  flagged            boolean       DEFAULT false,
  banned             boolean       DEFAULT false,
  flag_reason        text,
  ban_reason         text,
  total_bookings     integer       DEFAULT 0,
  total_spent        numeric(10,2) DEFAULT 0,
  first_booking_date date,
  last_booking_date  date,
  notes              text,
  full_name          text,
  driver_license     text,
  risk_flag          text          DEFAULT 'low',
  no_show_count      integer       NOT NULL DEFAULT 0,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

DO $$ BEGIN ALTER TABLE customers ADD CONSTRAINT customers_risk_flag_check
  CHECK (risk_flag IN ('low','medium','high'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE customers ADD CONSTRAINT customers_no_show_count_non_negative
  CHECK (no_show_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone)
  WHERE phone IS NOT NULL AND phone != '';
CREATE INDEX IF NOT EXISTS customers_email_idx  ON customers (email)  WHERE email  IS NOT NULL AND email  != '';
CREATE INDEX IF NOT EXISTS customers_banned_idx ON customers (banned);

DROP TRIGGER IF EXISTS customers_updated_at ON customers;
CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed real customers
INSERT INTO customers (name, full_name, phone, email, total_bookings, total_spent,
                       first_booking_date, last_booking_date, risk_flag, no_show_count)
VALUES
  ('David Agbebaku', 'David Agbebaku', '+13463814616', 'davosama15@gmail.com',   1, 479.59, '2026-03-21', '2026-03-28', 'low', 0),
  ('Mariatu Sillah', 'Mariatu Sillah', '+12137296017', 'marysillah23@gmail.com', 1, 200.00, '2026-03-13', '2026-03-17', 'low', 0),
  ('Bernard Gilot',  'Bernard Gilot',  '+14075586386', 'gilot42@gmail.com',      1, 485.00, '2026-02-19', '2026-03-02', 'low', 0)
ON CONFLICT (phone) DO UPDATE
  SET full_name          = COALESCE(customers.full_name, EXCLUDED.full_name),
      name               = EXCLUDED.name,
      email              = COALESCE(customers.email, EXCLUDED.email),
      total_bookings     = GREATEST(customers.total_bookings, EXCLUDED.total_bookings),
      total_spent        = GREATEST(customers.total_spent,    EXCLUDED.total_spent),
      first_booking_date = LEAST   (customers.first_booking_date, EXCLUDED.first_booking_date),
      last_booking_date  = GREATEST(customers.last_booking_date,  EXCLUDED.last_booking_date),
      updated_at         = now();

-- Back-fill full_name / risk_flag for any pre-existing rows that lack them
UPDATE customers
   SET full_name = COALESCE(full_name, name),
       risk_flag = CASE
                     WHEN risk_flag IS NOT NULL AND risk_flag != 'low' THEN risk_flag
                     WHEN banned  = true THEN 'high'
                     WHEN flagged = true THEN 'medium'
                     ELSE 'low'
                   END
 WHERE full_name IS NULL
    OR (risk_flag = 'low' AND (flagged = true OR banned = true));


-- =============================================================================
-- STEP 7  BOOKING STATUS HISTORY  (audit trail)
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
-- STEP 8  PAYMENT TRANSACTIONS  (full payment audit log)
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
CREATE INDEX IF NOT EXISTS pt_created_at_idx ON payment_transactions (created_at DESC);


-- =============================================================================
-- STEP 9  SMS TEMPLATE OVERRIDES
-- =============================================================================

CREATE TABLE IF NOT EXISTS sms_template_overrides (
  template_key  text        PRIMARY KEY,
  message       text,
  enabled       boolean     NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS sms_template_overrides_updated_at ON sms_template_overrides;
CREATE TRIGGER sms_template_overrides_updated_at
  BEFORE UPDATE ON sms_template_overrides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================================================
-- STEP 10  SITE SETTINGS  (Admin CMS — business info, hero text, policies)
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_settings (
  key        text        PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_settings_key ON site_settings (key);

DROP TRIGGER IF EXISTS site_settings_updated_at ON site_settings;
CREATE TRIGGER site_settings_updated_at
  BEFORE UPDATE ON site_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed defaults — never overwrite admin-customised values
INSERT INTO site_settings (key, value) VALUES
  ('business_name',           'SLY Transportation Services'),
  ('slingshot_business_name', 'SLY SLINGSHOT RENTALS'),
  ('phone',                   ''),
  ('whatsapp',                ''),
  ('email',                   ''),
  ('instagram_url',           ''),
  ('facebook_url',            ''),
  ('tiktok_url',              ''),
  ('twitter_url',             ''),
  ('promo_banner_enabled',    'false'),
  ('promo_banner_text',       ''),
  ('hero_title',              'Explore LA in Style'),
  ('hero_subtitle',           'Affordable car rentals in Los Angeles'),
  ('about_text',              ''),
  ('policies_cancellation',   ''),
  ('policies_damage',         ''),
  ('policies_fuel',           ''),
  ('policies_age',            ''),
  ('service_area_notes',      ''),
  ('pickup_instructions',     '')
ON CONFLICT (key) DO NOTHING;


-- =============================================================================
-- STEP 11  CONTENT BLOCKS  (FAQs, announcements, testimonials)
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_blocks (
  block_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text        NOT NULL CHECK (type IN ('faq','announcement','testimonial')),
  title           text,
  body            text,
  author_name     text,
  author_location text,
  sort_order      integer     NOT NULL DEFAULT 0,
  active          boolean     NOT NULL DEFAULT true,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_type   ON content_blocks (type);
CREATE INDEX IF NOT EXISTS idx_content_blocks_active ON content_blocks (active);
CREATE INDEX IF NOT EXISTS idx_content_blocks_sort   ON content_blocks (sort_order, created_at);

DROP TRIGGER IF EXISTS content_blocks_updated_at ON content_blocks;
CREATE TRIGGER content_blocks_updated_at
  BEFORE UPDATE ON content_blocks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed starter FAQs (only when table is empty)
INSERT INTO content_blocks (type, title, body, sort_order, active)
SELECT type, title, body, sort_order, active FROM (VALUES
  ('faq'::text, 'What is the minimum rental age?',
   'The minimum age to rent is 21 years old. A valid driver''s license is required.',         1, true),
  ('faq'::text, 'Do you offer airport pickup?',
   'Yes, we offer pickup and drop-off at major LA area airports. Contact us to arrange.',     2, true),
  ('faq'::text, 'What forms of payment do you accept?',
   'We accept all major credit cards via Stripe. Payments are processed securely online.',    3, true),
  ('faq'::text, 'Is there a security deposit?',
   'The Slingshot requires a $150 refundable security deposit. The Camry has no deposit.',   4, true)
) AS v(type, title, body, sort_order, active)
WHERE NOT EXISTS (SELECT 1 FROM content_blocks);


-- =============================================================================
-- STEP 12  CONTENT REVISIONS  (CMS revision history / rollback)
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_revisions (
  id            bigserial   PRIMARY KEY,
  resource_type text        NOT NULL,
  resource_id   text        NOT NULL,
  before        jsonb,
  after         jsonb,
  changed_keys  text[],
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_revisions_resource
  ON content_revisions (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_content_revisions_created
  ON content_revisions (created_at DESC);


-- =============================================================================
-- STEP 13  NORMALISED RENTAL TABLES
--          bookings + payments + blocked_dates + revenue
--          (Migrations 0014, 0015, 0017 fully integrated)
-- =============================================================================

-- ── 13a. bookings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref       text          UNIQUE,          -- bookingId in bookings.json
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
  payment_intent_id text,          -- Stripe PaymentIntent ID (migration 0033)
  activated_at      timestamptz,  -- stamped when status → 'active'   (migration 0017)
  completed_at      timestamptz,  -- stamped when status → 'completed' (migration 0017)
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

DO $$ BEGIN ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','approved','active','completed','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid','partial','paid'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS bookings_customer_id_idx        ON bookings (customer_id);
CREATE INDEX IF NOT EXISTS bookings_vehicle_id_idx         ON bookings (vehicle_id);
CREATE INDEX IF NOT EXISTS bookings_pickup_date_idx        ON bookings (pickup_date);
CREATE INDEX IF NOT EXISTS bookings_return_date_idx        ON bookings (return_date);
CREATE INDEX IF NOT EXISTS bookings_status_idx             ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_created_at_idx         ON bookings (created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_booking_ref_idx        ON bookings (booking_ref);
CREATE INDEX IF NOT EXISTS bookings_payment_intent_id_idx  ON bookings (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

DROP TRIGGER IF EXISTS bookings_updated_at ON bookings;
CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 13b. payments ─────────────────────────────────────────────────────────────
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

-- ── 13c. blocked_dates ────────────────────────────────────────────────────────
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

-- ── 13d. revenue  (trigger-managed FK ledger — lightweight) ───────────────────
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


-- =============================================================================
-- STEP 14  TRIGGER FUNCTIONS
-- All migrations 0014 / 0015 / 0016 / 0017 combined into one authoritative set.
-- =============================================================================

-- ── 14a. booking_datetime helper (migration 0015) ─────────────────────────────
-- Combines a date column and an optional time column into a precise timestamp.
-- When time is NULL and is_end=false → midnight of d (start of day).
-- When time is NULL and is_end=true  → midnight of d+1 (exclusive end boundary).
CREATE OR REPLACE FUNCTION booking_datetime(d date, t time, is_end boolean DEFAULT false)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t IS NOT NULL THEN (d + t)::timestamptz
    WHEN is_end        THEN (d + interval '1 day')::timestamptz
    ELSE                    d::timestamptz
  END
$$;

-- ── 14b. check_booking_conflicts  (datetime-aware, migration 0015) ────────────
-- BEFORE INSERT on bookings — rejects any booking that overlaps an existing one.
CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conflict_id uuid;
  v_blocked_vid text;
  new_start     timestamptz;
  new_end       timestamptz;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  IF NEW.pickup_date IS NULL  THEN RETURN NEW; END IF;

  new_start := booking_datetime(NEW.pickup_date, NEW.pickup_time, false);
  new_end   := booking_datetime(NEW.return_date, NEW.return_time, true);

  SELECT b.id INTO v_conflict_id
  FROM   bookings b
  WHERE  b.vehicle_id = NEW.vehicle_id
    AND  b.status NOT IN ('cancelled')
    AND  b.id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND  booking_datetime(b.pickup_date, b.pickup_time, false) < new_end
    AND  booking_datetime(b.return_date, b.return_time, true)  > new_start
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Booking conflict: vehicle % is already booked overlapping % to % (conflicts with %)',
      NEW.vehicle_id,
      new_start AT TIME ZONE 'UTC',
      new_end   AT TIME ZONE 'UTC',
      v_conflict_id;
  END IF;

  -- Check maintenance / manual blocked_dates only (not 'booking' — managed by bookings table)
  SELECT bd.vehicle_id INTO v_blocked_vid
  FROM   blocked_dates bd
  WHERE  bd.vehicle_id = NEW.vehicle_id
    AND  bd.reason    != 'booking'
    AND  bd.start_date <= COALESCE(NEW.return_date, NEW.pickup_date)
    AND  bd.end_date   >= NEW.pickup_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Date conflict: vehicle % has blocked dates overlapping % to %',
      NEW.vehicle_id, NEW.pickup_date, COALESCE(NEW.return_date, NEW.pickup_date);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_check_conflicts ON bookings;
CREATE TRIGGER bookings_check_conflicts
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION check_booking_conflicts();

-- ── 14c. on_booking_create  (migration 0015) ──────────────────────────────────
-- AFTER INSERT on bookings — auto-creates blocked_dates entry + revenue row,
-- and syncs vehicle rental_status for 'approved' and 'active' inserts.
CREATE OR REPLACE FUNCTION on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Block the vehicle dates for this booking period
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
    VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking')
    ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
  END IF;

  -- Auto-create a revenue row when the booking has a price
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Sync vehicle rental_status based on initial status
  CASE NEW.status
    WHEN 'approved' THEN UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active'   THEN UPDATE vehicles SET rental_status = 'rented'   WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_insert ON bookings;
CREATE TRIGGER bookings_after_insert
  AFTER INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_create();

-- ── 14d. on_booking_status_change  (migration 0015) ──────────────────────────
-- AFTER UPDATE OF status — implements the full rental lifecycle:
--   pending   → vehicle available
--   approved  → vehicle reserved
--   active    → vehicle rented
--   completed → vehicle available
--   cancelled → remove blocked_dates, remove unpaid revenue, vehicle available
CREATE OR REPLACE FUNCTION on_booking_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;

  CASE NEW.status
    WHEN 'pending' THEN
      UPDATE vehicles SET rental_status = 'available' WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'approved' THEN
      UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'active' THEN
      UPDATE vehicles SET rental_status = 'rented' WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'completed' THEN
      UPDATE vehicles SET rental_status = 'available' WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'cancelled' THEN
      -- Remove the date block created for this booking
      DELETE FROM blocked_dates
      WHERE  vehicle_id = NEW.vehicle_id
        AND  start_date = NEW.pickup_date
        AND  end_date   = NEW.return_date
        AND  reason     = 'booking';

      -- Remove revenue row only when no payment has been collected
      IF NEW.deposit_paid = 0 THEN
        DELETE FROM revenue WHERE booking_id = NEW.id;
      END IF;

      UPDATE vehicles SET rental_status = 'available' WHERE vehicle_id = NEW.vehicle_id;

    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_status_change ON bookings;
CREATE TRIGGER bookings_after_status_change
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_change();

-- ── 14e. on_booking_status_timestamps  (migration 0017) ──────────────────────
-- BEFORE INSERT OR UPDATE OF status — auto-stamps activated_at / completed_at.
CREATE OR REPLACE FUNCTION on_booking_status_timestamps()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  CASE NEW.status
    WHEN 'active'    THEN IF NEW.activated_at IS NULL THEN NEW.activated_at := now(); END IF;
    WHEN 'completed' THEN IF NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_status_timestamps ON bookings;
CREATE TRIGGER bookings_status_timestamps
  BEFORE INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_timestamps();

-- ── 14f. on_payment_create ────────────────────────────────────────────────────
-- AFTER INSERT on payments — recomputes deposit_paid / remaining_balance /
-- payment_status on the parent booking row.
CREATE OR REPLACE FUNCTION on_payment_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_total   numeric;
  v_paid    numeric;
  v_pstatus text;
BEGIN
  SELECT total_price, deposit_paid INTO v_total, v_paid FROM bookings WHERE id = NEW.booking_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF   NEW.type = 'refund' THEN v_paid := GREATEST(0, v_paid - NEW.amount);
  ELSE                          v_paid := v_paid + NEW.amount;
  END IF;

  v_pstatus := CASE
    WHEN v_total > 0 AND v_paid >= v_total THEN 'paid'
    WHEN v_paid  > 0                       THEN 'partial'
    ELSE                                        'unpaid'
  END;

  UPDATE bookings
     SET deposit_paid      = v_paid,
         remaining_balance = GREATEST(0, v_total - v_paid),
         payment_status    = v_pstatus
   WHERE id = NEW.booking_id;

  IF NEW.type != 'refund' THEN
    UPDATE revenue SET gross = v_paid WHERE booking_id = NEW.booking_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_after_insert ON payments;
CREATE TRIGGER payments_after_insert
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION on_payment_create();

-- ── 14g. update_customer_no_show_count  (migration 0016) ─────────────────────
-- AFTER INSERT / UPDATE OF is_no_show / DELETE on revenue_records —
-- keeps customers.no_show_count automatically in sync.
CREATE OR REPLACE FUNCTION update_customer_no_show_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_phone text;
  v_delta integer := 0;
BEGIN
  IF    TG_OP = 'DELETE' THEN
    v_phone := OLD.customer_phone;
    IF OLD.is_no_show THEN v_delta := -1; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_phone := NEW.customer_phone;
    IF NEW.is_no_show THEN v_delta := 1; END IF;
  ELSE  -- UPDATE
    v_phone := NEW.customer_phone;
    IF     OLD.is_no_show = false AND NEW.is_no_show = true  THEN v_delta :=  1;
    ELSIF  OLD.is_no_show = true  AND NEW.is_no_show = false THEN v_delta := -1;
    END IF;
  END IF;

  IF v_delta = 0 OR v_phone IS NULL OR v_phone = '' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE customers
     SET no_show_count = GREATEST(0, no_show_count + v_delta),
         updated_at    = now()
   WHERE phone = v_phone;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS on_revenue_no_show_change ON revenue_records;
CREATE TRIGGER on_revenue_no_show_change
  AFTER INSERT OR UPDATE OF is_no_show OR DELETE
  ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION update_customer_no_show_count();


-- =============================================================================
-- STEP 15  VIEW: vehicle_revenue_summary
-- Used by the Finance tab KPI cards and the Analytics page in admin-v2.
-- =============================================================================

CREATE OR REPLACE VIEW vehicle_revenue_summary AS
SELECT
  vehicle_id,
  COUNT(*)                     FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS booking_count,
  COUNT(*)                     FILTER (WHERE is_cancelled)                        AS cancelled_count,
  COUNT(*)                     FILTER (WHERE is_no_show)                          AS no_show_count,
  COALESCE(SUM(gross_amount)   FILTER (WHERE NOT is_cancelled AND NOT is_no_show), 0) AS total_gross,
  COALESCE(SUM(refund_amount),                                                     0) AS total_refunds,
  COALESCE(SUM(net_amount)     FILTER (WHERE NOT is_cancelled AND NOT is_no_show), 0) AS total_net,
  COALESCE(SUM(deposit_amount) FILTER (WHERE NOT is_cancelled),                    0) AS total_deposits,
  MAX(return_date)                                                                     AS last_return_date,
  MIN(pickup_date)                                                                     AS first_pickup_date
FROM revenue_records
GROUP BY vehicle_id;


-- =============================================================================
-- STEP 16  VEHICLE IMAGE STORAGE BUCKET
-- Public bucket for admin panel vehicle photo uploads.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-images', 'vehicle-images', true,
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
  ON storage.objects FOR SELECT
  USING (bucket_id = 'vehicle-images');

CREATE POLICY "vehicle-images: service write"
  ON storage.objects FOR ALL
  USING     (bucket_id = 'vehicle-images' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'vehicle-images' AND auth.role() = 'service_role');


-- =============================================================================
-- STEP 17  DISABLE ROW LEVEL SECURITY
-- The API uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS automatically,
-- but disabling it explicitly prevents accidental permission errors.
-- =============================================================================

ALTER TABLE vehicles               DISABLE ROW LEVEL SECURITY;
ALTER TABLE protection_plans       DISABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings        DISABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_records        DISABLE ROW LEVEL SECURITY;
ALTER TABLE expenses               DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers              DISABLE ROW LEVEL SECURITY;
ALTER TABLE bookings               DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments               DISABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_dates          DISABLE ROW LEVEL SECURITY;
ALTER TABLE revenue                DISABLE ROW LEVEL SECURITY;
ALTER TABLE booking_status_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions   DISABLE ROW LEVEL SECURITY;
ALTER TABLE sms_template_overrides DISABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings          DISABLE ROW LEVEL SECURITY;
ALTER TABLE content_blocks         DISABLE ROW LEVEL SECURITY;
ALTER TABLE content_revisions      DISABLE ROW LEVEL SECURITY;


-- =============================================================================
-- STEP 18  SEED NORMALISED BOOKINGS  (real 2026 rentals)
-- Must run after all triggers are in place. The conflict-check trigger is
-- temporarily disabled so historical overlapping dates can be inserted cleanly.
-- =============================================================================

-- Ensure customers exist (already seeded in STEP 6 — this is idempotent)
INSERT INTO customers (name, full_name, phone, email, risk_flag) VALUES
  ('Mariatu Sillah', 'Mariatu Sillah', '+12137296017', 'marysillah23@gmail.com', 'low'),
  ('Bernard Gilot',  'Bernard Gilot',  '+14075586386', 'gilot42@gmail.com',      'low'),
  ('David Agbebaku', 'David Agbebaku', '+13463814616', 'davosama15@gmail.com',   'low')
ON CONFLICT (phone) DO UPDATE
  SET full_name  = COALESCE(customers.full_name,  EXCLUDED.full_name),
      email      = COALESCE(customers.email,      EXCLUDED.email),
      updated_at = now();

-- Disable conflict trigger so historical data can be inserted cleanly
ALTER TABLE bookings DISABLE TRIGGER bookings_check_conflicts;

INSERT INTO bookings (booking_ref, customer_id, vehicle_id,
                      pickup_date, return_date, pickup_time, return_time,
                      status, total_price, deposit_paid, remaining_balance,
                      payment_status, notes, payment_method, created_at)
SELECT 'bk-ms-2026-0313', c.id, 'camry',
       '2026-03-13', '2026-03-17', '11:00:00', '11:00:00',
       'completed', 200.00, 200.00, 0.00, 'paid', '4-day rental', 'cash',
       '2026-03-12 18:00:00+00'
FROM customers c WHERE c.phone = '+12137296017'
ON CONFLICT (booking_ref) DO NOTHING;

INSERT INTO bookings (booking_ref, customer_id, vehicle_id,
                      pickup_date, return_date, pickup_time, return_time,
                      status, total_price, deposit_paid, remaining_balance,
                      payment_status, notes, payment_method, created_at)
SELECT 'bk-bg-2026-0219', c.id, 'camry',
       '2026-02-19', '2026-03-02', '21:00:00', '21:00:00',
       'completed', 485.00, 485.00, 0.00, 'paid', '$300 refunded — car broke down', 'cash',
       '2026-02-18 18:00:00+00'
FROM customers c WHERE c.phone = '+14075586386'
ON CONFLICT (booking_ref) DO NOTHING;

INSERT INTO bookings (booking_ref, customer_id, vehicle_id,
                      pickup_date, return_date, pickup_time, return_time,
                      status, total_price, deposit_paid, remaining_balance,
                      payment_status, notes, payment_method, created_at)
SELECT 'bk-da-2026-0321', c.id, 'camry2013',
       '2026-03-21', '2026-03-28', '22:45:00', '05:45:00',
       'completed', 479.59, 479.59, 0.00, 'paid', '7-day rental', 'stripe',
       '2026-03-20 18:00:00+00'
FROM customers c WHERE c.phone = '+13463814616'
ON CONFLICT (booking_ref) DO NOTHING;

-- Re-enable conflict trigger for all future bookings
ALTER TABLE bookings ENABLE TRIGGER bookings_check_conflicts;

-- Seed matching blocked_dates rows
INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
SELECT b.vehicle_id, b.pickup_date, b.return_date, 'booking'
FROM   bookings b
WHERE  b.booking_ref IN ('bk-ms-2026-0313','bk-bg-2026-0219','bk-da-2026-0321')
  AND  b.status NOT IN ('cancelled')
ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;

-- Seed matching revenue rows (the trigger-managed revenue table)
INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
SELECT b.id, b.vehicle_id, b.deposit_paid, 0
FROM   bookings b
WHERE  b.booking_ref IN ('bk-ms-2026-0313','bk-bg-2026-0219','bk-da-2026-0321')
  AND  b.deposit_paid > 0
ON CONFLICT (booking_id) DO NOTHING;


-- =============================================================================
-- STEP 19  VERIFICATION QUERIES
-- Run these after the main script to confirm everything was set up correctly.
-- Just look for the expected counts / names in the Results panel.
-- =============================================================================

-- 19a. Tables (expect 16 tables)
SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'public'
ORDER  BY table_name;

-- 19b. All 5 fleet vehicles
SELECT vehicle_id, vehicle_name, vehicle_type, daily_price, deposit_amount, rental_status
FROM   vehicles
ORDER  BY vehicle_id;

-- 19c. Pricing + tax settings  (expect 14 rows)
SELECT key, value::text AS rate
FROM   system_settings
WHERE  category IN ('pricing','tax')
ORDER  BY category, key;

-- 19d. Revenue records seeded  (expect 3 rows)
SELECT booking_id, vehicle_id, customer_name, gross_amount, refund_amount, net_amount, payment_status
FROM   revenue_records
ORDER  BY pickup_date;

-- 19e. Customers  (expect >= 3 rows)
SELECT name, phone, total_bookings, no_show_count, risk_flag
FROM   customers
ORDER  BY name;

-- 19f. Normalised bookings  (expect 3 rows)
SELECT booking_ref, vehicle_id, status, total_price, deposit_paid, payment_status
FROM   bookings
ORDER  BY pickup_date;

-- 19g. Finance tab summary view  (expect 3 rows — one per vehicle that has bookings)
SELECT vehicle_id, booking_count, total_gross, total_refunds, total_net
FROM   vehicle_revenue_summary
ORDER  BY vehicle_id;

-- 19h. Trigger functions installed (expect >= 7)
SELECT routine_name
FROM   information_schema.routines
WHERE  routine_type   = 'FUNCTION'
  AND  routine_schema = 'public'
ORDER  BY routine_name;

-- =============================================================================
-- ALL DONE
-- Every table, index, trigger function, view, storage bucket, and seed row for
-- SLY RIDES is now in place.  Covers migrations 0001 – 0017.
-- Safe to run again at any time — fully idempotent.
-- =============================================================================
