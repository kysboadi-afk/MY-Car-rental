-- 0005_fixes.sql
-- Runtime database fixes for the admin portal audit.
--
-- What this migration does:
--   1. Deduplicates revenue_records by booking_id (keeps oldest row).
--   2. Adds a UNIQUE constraint on revenue_records.booking_id so future
--      idempotent inserts (ON CONFLICT (booking_id) DO NOTHING) work correctly.
--   3. Updates sample customers (from 0004_sample_data.sql) with phone numbers
--      that match the updated bookings.json sample data.
--   4. Updates sample revenue records with the matching customer phone numbers.
--   5. Re-seeds any sample data that may be missing (idempotent via the new
--      unique constraint on booking_id).
--
-- Run AFTER migration 0004 (which must be applied first).
-- Safe to re-run: all statements are idempotent.

-- ── 1. Remove duplicate revenue records, keeping the earliest per booking_id ─

DELETE FROM revenue_records
WHERE id NOT IN (
  SELECT DISTINCT ON (booking_id) id
  FROM revenue_records
  ORDER BY booking_id, created_at ASC
);

-- ── 2. Add unique constraint on revenue_records.booking_id ────────────────────

ALTER TABLE revenue_records
  DROP CONSTRAINT IF EXISTS revenue_records_booking_id_unique;

ALTER TABLE revenue_records
  ADD CONSTRAINT revenue_records_booking_id_unique UNIQUE (booking_id);

-- ── 3. Update sample customers with phone numbers ──────────────────────────────
-- These UPDATE statements are no-ops when the customers do not yet exist;
-- migration 0004 inserts them first and 0005 assigns their phone numbers.

UPDATE customers
SET    phone = '+12135550101', email = 'd.agbebaku@example.com', updated_at = now()
WHERE  name  = 'David Agbebaku' AND (phone IS NULL OR phone = '');

UPDATE customers
SET    phone = '+12135550102', email = 'm.sillah@example.com', updated_at = now()
WHERE  name  = 'Mariatu Sillah' AND (phone IS NULL OR phone = '');

UPDATE customers
SET    phone = '+12135550103', email = 'b.gilot@example.com', updated_at = now()
WHERE  name  = 'Bernard Gilot' AND (phone IS NULL OR phone = '');

-- ── 4. Update sample revenue records with customer phone numbers ───────────────

UPDATE revenue_records
SET    customer_phone = '+12135550101', customer_email = 'd.agbebaku@example.com'
WHERE  booking_id = 'sample-da-001';

UPDATE revenue_records
SET    customer_phone = '+12135550102', customer_email = 'm.sillah@example.com'
WHERE  booking_id = 'sample-ms-001';

UPDATE revenue_records
SET    customer_phone = '+12135550103', customer_email = 'b.gilot@example.com'
WHERE  booking_id = 'sample-bg-002';

-- ── 5. Re-seed any missing sample revenue records (idempotent) ────────────────
-- Now that booking_id has a unique constraint, ON CONFLICT (booking_id) DO NOTHING
-- works correctly and prevents duplicates on repeated migration runs.

INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-da-001', 'camry2013', 'David Agbebaku', '+12135550101', 'd.agbebaku@example.com',
  '2025-10-01', '2025-10-08',
  479.59, 0, 0,
  'stripe', 'paid',
  '7-day rental — sample booking', true
) ON CONFLICT (booking_id) DO NOTHING;

INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-ms-001', 'camry', 'Mariatu Sillah', '+12135550102', 'm.sillah@example.com',
  '2025-11-15', '2025-11-19',
  200.00, 0, 0,
  'cash', 'paid',
  '4-day rental — sample booking', true
) ON CONFLICT (booking_id) DO NOTHING;

INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-bg-002', 'camry', 'Bernard Gilot', '+12135550103', 'b.gilot@example.com',
  '2025-12-01', '2025-12-12',
  785.00, 0, 300.00,
  'cash', 'partial',
  '11-day rental — $300 refunded, net $485', true
) ON CONFLICT (booking_id) DO NOTHING;

-- ── 6. Re-seed any missing sample customers (idempotent via phone unique index) ─

INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
VALUES
  ('David Agbebaku',  '+12135550101', 'd.agbebaku@example.com', 1, 479.59, '2025-10-01', '2025-10-08'),
  ('Mariatu Sillah',  '+12135550102', 'm.sillah@example.com',   1, 200.00, '2025-11-15', '2025-11-19'),
  ('Bernard Gilot',   '+12135550103', 'b.gilot@example.com',    1, 785.00, '2025-12-01', '2025-12-12')
ON CONFLICT (phone) DO UPDATE
  SET
    email              = EXCLUDED.email,
    total_bookings     = EXCLUDED.total_bookings,
    total_spent        = EXCLUDED.total_spent,
    first_booking_date = EXCLUDED.first_booking_date,
    last_booking_date  = EXCLUDED.last_booking_date,
    updated_at         = now()
  WHERE customers.phone = EXCLUDED.phone;
