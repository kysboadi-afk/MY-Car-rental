-- Migration 0106: clear stale is_orphan=true flags on revenue_records whose
--                  booking_id now matches a real bookings.booking_ref.
--
-- Background:
--   The original health-check (check_revenue_booking_ref trigger in 0060 and
--   the fixOrphanRevenue function in v2-system-health.js) had a bug that
--   queried the non-existent bookings.booking_id column instead of
--   bookings.booking_ref.  When PostgREST returned an empty result for the
--   unknown column every revenue record appeared to have no matching booking,
--   and running "Fix Now" from the health panel flagged all of them as
--   is_orphan=true.
--
--   Migration 0104 performed a one-time repair for extension and rental records
--   created up to that point.  This migration extends the repair to ALL types
--   (including fee and any other future types) and covers records created after
--   migration 0104 that may have been incorrectly flagged by subsequent
--   executions before the JS code fix in v2-system-health.js was deployed.
--
-- Fix:
--   For every revenue_records row where:
--     • is_orphan = true
--     • sync_excluded = false
--     • booking_id IS NOT NULL
--     • booking_id matches bookings.booking_ref
--   → set is_orphan = false and update updated_at.
--
-- Safe to re-run: UPDATE uses idempotent WHERE clause; rows already set to
-- is_orphan=false are untouched.

UPDATE revenue_records
SET    is_orphan  = false,
       updated_at = now()
WHERE  is_orphan      = true
  AND  sync_excluded  = false
  AND  booking_id     IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings WHERE booking_ref = revenue_records.booking_id
       );
