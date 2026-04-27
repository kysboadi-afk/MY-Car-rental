-- Migration 0093: Re-apply expanded bookings.status CHECK constraint
--
-- Problem: The bookings_status_check constraint was last set in migration 0056 to
-- only allow ('pending','active','overdue','completed').  Migration 0081 was meant
-- to expand it, but may not have been applied to all environments (e.g. the live
-- Supabase project).  As a result, writing status='completed_rental' when the admin
-- clicks "✓ Returned" on an overdue booking fails with:
--   "new row for relation "bookings" violates check constraint "bookings_status_check""
--
-- Fix: Drop and re-add the constraint with the full set of status values used
-- anywhere in the application layer.  Idempotent — safe to re-run.

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    -- Legacy values (stripe-webhook / autoUpsertBooking pre-0064)
    'pending',
    'approved',
    'active',
    'overdue',
    'completed',
    'cancelled',
    -- Post-0066 values
    'reserved',
    'pending_verification',
    -- Modern app-layer values (booking pipeline / admin panel / v2-bookings.js)
    'active_rental',
    'booked_paid',
    'completed_rental',
    'cancelled_rental'
  ));
