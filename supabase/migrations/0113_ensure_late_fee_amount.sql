-- Migration 0113: Ensure bookings.late_fee_amount column exists (catch-up for migration ordering gap)
--
-- Background:
--   Migration 0075 (0075_late_fee_approval_tracking.sql) defines bookings.late_fee_amount
--   as numeric(10,2).  However, the duplicate-numbered 0104 files
--   (0104_ensure_renter_phone.sql and 0104_fix_extension_revenue_orphan_and_visibility.sql)
--   introduced an ordering ambiguity in some deployment environments that could cause 0075
--   to be skipped or applied out-of-sequence, leaving bookings.late_fee_amount absent.
--
--   scheduled-reminders.js writes late_fee_amount to the bookings table when a late fee
--   is assessed (see loadBookingsFromSupabase SELECT list and the pending_approval write
--   block).  If the column is missing, the SELECT query returns PostgreSQL error 42703
--   (undefined column), surfacing as a 500 on /api/system-health-fix-sms.
--
--   This migration is fully idempotent — ADD COLUMN IF NOT EXISTS is safe to run even
--   if 0075 was already applied.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS late_fee_amount      numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_status      text
    CHECK (late_fee_status IN ('pending_approval','approved','dismissed','failed','paid')),
  ADD COLUMN IF NOT EXISTS late_fee_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_fee_approved_by text;

-- Partial index used by the late-fee approval flow.
CREATE INDEX IF NOT EXISTS bookings_late_fee_status_idx
  ON bookings (late_fee_status)
  WHERE late_fee_status IS NOT NULL;

COMMENT ON COLUMN bookings.late_fee_amount IS
  'Assessed late-fee amount in USD, set when late_fee_status is first written. '
  'Originally added in migration 0075; catch-up ensured by migration 0113.';
COMMENT ON COLUMN bookings.late_fee_status IS
  'Tracks where the late-fee approval stands: pending_approval → approved/dismissed/failed/paid. '
  'Originally added in migration 0075; catch-up ensured by migration 0113.';
COMMENT ON COLUMN bookings.late_fee_approved_at IS
  'Timestamp when admin approved or dismissed the late fee.';
COMMENT ON COLUMN bookings.late_fee_approved_by IS
  'Who actioned the approval: admin_link | admin_panel | ai.';
