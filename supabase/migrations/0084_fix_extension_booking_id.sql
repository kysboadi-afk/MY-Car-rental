-- Migration 0084: fix extension revenue_records so booking_id = canonical booking_ref
--
-- Problem:
--   Extension revenue records were created with booking_id set to either:
--     • A synthetic "ext-{original_booking_id}-{timestamp}" placeholder
--       (produced by the old v2-revenue.js record_extension_fee action).
--     • A Stripe PaymentIntent ID ("pi_xxx") — old behaviour before
--       autoCreateRevenueRecord was standardised to use canonical refs.
--
--   Because the admin revenue view groups rows by booking_id, these extensions
--   appeared as separate bookings instead of collapsing under the parent rental.
--
-- Fix (three independent passes):
--
--   Pass 1 — synthetic ext- records (from record_extension_fee):
--     Set booking_id = original_booking_id and type = 'extension'.
--     original_booking_id is the canonical booking_ref passed by the caller.
--     These records may also have type = 'rental' (the DB default at insertion
--     time), so type is corrected in the same statement.
--     is_orphan is cleared once the canonical booking_id is verified.
--
--   Pass 2 — extension records with a PI-based booking_id:
--     When booking_id looks like a Stripe PI ("pi_xxx") but original_booking_id
--     IS a valid bookings.booking_ref, update booking_id = original_booking_id.
--     is_orphan is cleared when the new booking_id is verified.
--
--   Pass 3 — backfill original_booking_id = booking_id for new-style extensions:
--     autoCreateRevenueRecord now sets both fields consistently, but existing rows
--     created before this change have original_booking_id = NULL.  Fill them in
--     so both fields are canonical for all extension records.
--
-- All three passes are safe to re-run (idempotent WHERE clauses).
-- The DB trigger check_revenue_booking_ref fires on each UPDATE; it verifies
-- that the new booking_id exists in bookings.booking_ref — which is guaranteed
-- by the EXISTS sub-select guard in each statement.

-- ── Pass 1: fix synthetic "ext-…" booking_ids ────────────────────────────────
-- Note: booking_id LIKE 'ext-%' requires a sequential scan of the table.
-- This is a one-time data repair migration and the table is not expected to be
-- large enough to warrant a specialised index for this single run.
UPDATE revenue_records
SET    booking_id  = original_booking_id,
       type        = 'extension',
       is_orphan   = false,
       updated_at  = now()
WHERE  sync_excluded        = false
  AND  booking_id            LIKE 'ext-%'
  AND  original_booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.original_booking_id
       );

-- ── Pass 2: fix Stripe PI-based booking_ids on extension rows ────────────────
UPDATE revenue_records
SET    booking_id  = original_booking_id,
       is_orphan   = false,
       updated_at  = now()
WHERE  type                  = 'extension'
  AND  sync_excluded         = false
  AND  booking_id             LIKE 'pi_%'
  AND  original_booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.original_booking_id
       );

-- ── Pass 3: backfill original_booking_id for new-style extensions ────────────
UPDATE revenue_records
SET    original_booking_id = booking_id,
       updated_at          = now()
WHERE  type              = 'extension'
  AND  sync_excluded     = false
  AND  is_orphan         = false
  AND  original_booking_id IS NULL
  AND  booking_id          IS NOT NULL
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.booking_id
       );
