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

-- Seed the four fleet vehicles (safe to re-run — ignores conflicts)
INSERT INTO vehicles (vehicle_id, data) VALUES
  ('slingshot',  '{"vehicle_id":"slingshot",  "vehicle_name":"Slingshot R",     "type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/car2.jpg"}'::jsonb),
  ('slingshot2', '{"vehicle_id":"slingshot2", "vehicle_name":"Slingshot R (2)", "type":"slingshot","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/IMG_1749.jpeg"}'::jsonb),
  ('camry',      '{"vehicle_id":"camry",      "vehicle_name":"Camry 2012",      "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/IMG_0046.png"}'::jsonb),
  ('camry2013',  '{"vehicle_id":"camry2013",  "vehicle_name":"Camry 2013 SE",   "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"../images/IMG_5144.png"}'::jsonb)
ON CONFLICT (vehicle_id) DO UPDATE
  SET data = excluded.data
  WHERE vehicles.data = '{}'::jsonb OR vehicles.data IS NULL;


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
