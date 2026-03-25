-- 0006_expenses_and_real_data.sql
--
-- What this migration does:
--   1. Creates the `expenses` table so expense records are stored in Supabase
--      instead of GitHub (more reliable for reads AND writes).
--   2. Removes stale 2025 sample revenue records and fake-phone customers that
--      were seeded by migrations 0004 and 0005.
--   3. Inserts real 2026 revenue records and real customer profiles for the
--      three actual rentals on record.
--
-- Safe to re-run: all DML uses ON CONFLICT / WHERE guards.

-- ── 1. Create expenses table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expenses (
  expense_id  text        PRIMARY KEY,
  vehicle_id  text        NOT NULL,
  date        date        NOT NULL,
  category    text        NOT NULL
                          CHECK (category IN ('maintenance','insurance','repair','fuel','registration','other')),
  amount      numeric(10,2) NOT NULL CHECK (amount > 0),
  notes       text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expenses_vehicle_id_idx ON expenses (vehicle_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx       ON expenses (date DESC);

-- ── 2. Remove stale 2025 sample revenue records ───────────────────────────
-- These were seeded by migrations 0004/0005 with fake booking IDs and
-- placeholder 2025 dates.  Real 2026 records are inserted below.

DELETE FROM revenue_records
WHERE booking_id IN ('sample-da-001', 'sample-ms-001', 'sample-bg-002');

-- ── 3. Remove stale sample customers (identified by fake phone numbers) ───
-- Migrations 0004/0005 seeded these with placeholder phones (+12135550101 etc.).
-- Real customers with actual phones are upserted below.

DELETE FROM customers
WHERE phone IN ('+12135550101', '+12135550102', '+12135550103');

-- ── 4. Upsert real 2026 revenue records ───────────────────────────────────

-- David Agbebaku — Camry 2013 SE, 7 days, $479.59 (active rental)
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'bk-da-2026-0321', 'camry2013', 'David Agbebaku', '+13463814616', 'davosama15@gmail.com',
  '2026-03-21', '2026-03-28',
  479.59, 0, 0,
  'stripe', 'paid',
  '7-day rental', true
) ON CONFLICT (booking_id) DO NOTHING;

-- Mariatu Sillah — Camry 2012, 4 days, $200
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'bk-ms-2026-0313', 'camry', 'Mariatu Sillah', '+12137296017', 'marysillah23@gamil.com',
  '2026-03-13', '2026-03-17',
  200.00, 0, 0,
  'cash', 'paid',
  '4-day rental', true
) ON CONFLICT (booking_id) DO NOTHING;

-- Bernard Gilot — Camry 2012, 11 days, $785 gross / $300 refund / $485 net
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'bk-bg-2026-0219', 'camry', 'Bernard Gilot', '+14075586386', 'gilot42@gmail.com',
  '2026-02-19', '2026-03-02',
  785.00, 0, 300.00,
  'cash', 'partial',
  '11-day rental — $300 refunded (car broke down)', true
) ON CONFLICT (booking_id) DO NOTHING;

-- ── 5. Upsert real 2026 customers ─────────────────────────────────────────

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
