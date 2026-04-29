-- Migration 0107: remove synthetic "stripe-pi_xxx" booking IDs from revenue_records
--                 and add a CHECK constraint to prevent them in future.
--
-- Background:
--   A previous version of stripe-reconcile.js's auto-create path used a synthetic
--   "stripe-" + payment_intent_id string as the booking_id when no real booking
--   reference could be resolved.  These synthetic strings are not valid booking_ref
--   values — they have no matching row in the bookings table — yet they are stored
--   as non-null booking_ids, bypassing the is_orphan=true escape hatch and causing:
--     1. False-positive "Orphan Revenue Records" and "Payment → No Booking" alerts
--        in System Health.
--     2. Confusion in the Revenue Tracker (rows that look linked but are not).
--   The proper escape hatch for an unresolvable payment is booking_id=NULL with
--   is_orphan=true, as used by createOrphanRevenueRecord in _booking-automation.js.
--
-- Fix — two parts:
--   1. Backfill: for every existing revenue_records row where booking_id starts
--      with 'stripe-', set booking_id=NULL and is_orphan=true so the row behaves
--      like a proper orphan record (visible in admin, excluded from aggregation).
--
--   2. Constraint: add a CHECK constraint that rejects any future INSERT or UPDATE
--      that would set booking_id to a value starting with 'stripe-'.  The constraint
--      allows NULL (legitimate orphan rows) and any other non-synthetic string.
--
-- Safe to re-run: the backfill uses a guarded WHERE clause; the constraint uses
-- ADD CONSTRAINT IF NOT EXISTS (no-op when already present).

-- ── 1. Backfill existing synthetic rows ──────────────────────────────────────
UPDATE revenue_records
SET    booking_id  = NULL,
       is_orphan   = true,
       updated_at  = now()
WHERE  booking_id  LIKE 'stripe-%'
  AND  is_orphan   = false;

-- ── 2. Block synthetic booking IDs going forward ─────────────────────────────
ALTER TABLE revenue_records
  ADD CONSTRAINT IF NOT EXISTS revenue_records_no_synthetic_booking_id
  CHECK (booking_id IS NULL OR booking_id NOT LIKE 'stripe-%');
