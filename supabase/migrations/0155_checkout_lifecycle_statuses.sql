-- Migration 0155: explicit checkout lifecycle statuses
--
-- Goal:
--   Separate incomplete/failed checkout attempts from real unpaid reservations.
--
-- Adds:
--   pending_checkout
--   upload_failed
--   payment_failed
--   abandoned_checkout
--
-- Keeps:
--   reserved as the confirmed unpaid reservation state that still blocks inventory.

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    -- Incomplete checkout lifecycle
    'pending',
    'pending_checkout',
    'upload_failed',
    'payment_failed',
    'abandoned_checkout',
    -- Legacy values
    'approved',
    'active',
    'overdue',
    'completed',
    'cancelled',
    -- Operational reservation / rental values
    'reserved',
    'pending_verification',
    'active_rental',
    'booked_paid',
    'completed_rental',
    'cancelled_rental'
  ));
