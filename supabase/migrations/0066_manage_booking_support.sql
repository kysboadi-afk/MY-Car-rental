-- Migration 0066: Customer-managed reservation support
--
-- Adds the columns and constraint relaxations needed for customers to view and
-- edit their own booking after paying a reservation deposit.
--
-- New columns on bookings:
--   change_count           — counts how many date/vehicle/plan changes have been applied
--   manage_token           — short-lived HMAC token sent to the customer for portal access
--   balance_payment_link   — current URL for the customer to pay the remaining balance
--   pending_change         — JSONB snapshot of a change awaiting a change-fee payment
--
-- Constraint changes:
--   bookings_status_check         — adds 'reserved' and 'pending_verification'
--   bookings_payment_status_check — adds 'partial'

-- ── 1. New columns ─────────────────────────────────────────────────────────────

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS change_count         integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS manage_token         text    UNIQUE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_payment_link text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pending_change       jsonb;

-- ── 2. Relax status check to include 'reserved' and 'pending_verification' ────

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'pending',
    'reserved',
    'pending_verification',
    'active',
    'overdue',
    'completed'
  ));

-- ── 3. Relax payment_status check to include 'partial' ────────────────────────

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid', 'partial', 'paid'));

-- ── 4. Index for fast manage_token lookups ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS bookings_manage_token_idx
  ON bookings (manage_token)
  WHERE manage_token IS NOT NULL;
