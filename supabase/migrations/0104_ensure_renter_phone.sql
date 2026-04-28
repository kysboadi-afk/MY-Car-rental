-- Migration 0104: Ensure bookings.renter_phone column exists (catch-up for dual-0101 conflict)
--
-- Background:
--   Two migrations were inadvertently numbered 0101:
--     0101_add_renter_phone.sql      — adds bookings.renter_phone
--     0101_sms_delivery_logs.sql     — creates the sms_delivery_logs table
--   Migration 0103 corrected the sms_delivery_logs gap.  This migration corrects
--   the renter_phone gap: if 0101_add_renter_phone.sql was not applied, the
--   bookings.renter_phone column is absent, causing the SELECT query in
--   scheduled-reminders.js loadBookingsFromSupabase() to fail (PostgreSQL error
--   42703 — undefined column), which surfaces as a 500 on /api/system-health-fix-sms.
--
--   This migration is fully idempotent — ADD COLUMN IF NOT EXISTS and
--   CREATE INDEX IF NOT EXISTS are safe to run even if 0101 was already applied.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS renter_phone text;

-- Backfill from customer_phone for rows written before this column existed.
UPDATE bookings
SET    renter_phone = customer_phone
WHERE  renter_phone IS NULL
  AND  customer_phone IS NOT NULL;

-- Partial index used by the Stripe phone back-fill logic in _booking-automation.js.
CREATE INDEX IF NOT EXISTS idx_bookings_renter_phone_null
  ON bookings (id)
  WHERE renter_phone IS NULL;

COMMENT ON COLUMN bookings.renter_phone IS
  'Canonical E.164 phone number for SMS delivery. Prefer over customer_phone. '
  'Added in migration 0101; catch-up ensured by migration 0104.';
