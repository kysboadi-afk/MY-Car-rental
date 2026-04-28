-- Migration 0104: fix extension revenue orphan detection and booking_revenue_grouped visibility
--
-- Problem:
--   1. checkOrphanRevenue / fixOrphanRevenue in v2-system-health.js used
--      .eq("type", "rental"), which excluded extension records entirely.
--      Extension records with a missing or stale booking_id were therefore
--      never detected or repaired, and valid extension records could never be
--      cleared if they were accidentally marked is_orphan=true.
--
--   2. Both functions queried bookings.booking_id (which does not exist on
--      the bookings table) instead of bookings.booking_ref.  When PostgREST
--      returned an error for the unknown column the fix function threw before
--      touching any rows, but when it returned empty rows (no error) ALL
--      revenue_records were considered orphans and could be flagged
--      is_orphan=true — causing them to disappear from the admin Revenue tab
--      (the list_by_booking JS fallback path filters is_orphan = false).
--
-- Fix (two passes):
--
--   Pass 1 — Unorphan valid extension records:
--     Clear is_orphan=true on any extension records whose booking_id matches
--     a real booking_ref.  These were either set by a buggy fixOrphanRevenue
--     run or by an old stripe-reconcile path.  Safe to re-run (idempotent).
--
--   Pass 2 — Unorphan valid rental records:
--     Clear is_orphan=true on any rental/other records whose booking_id
--     matches a real booking_ref (defensive repair for the bookings.booking_id
--     query bug described above).  Safe to re-run.
--
--   Pass 3 — Refresh booking_revenue_grouped view:
--     Re-create the view to ensure it explicitly includes all record types
--     (rental, extension, fee) in both the records JSONB array and the
--     gross_total sum.  The view already had no type filter on records, so
--     this is purely a documentation / defense-in-depth refresh.
--
-- Safe to re-run: UPDATE uses idempotent WHERE clause; CREATE OR REPLACE VIEW
-- is idempotent.

-- ── Pass 1: unorphan valid extension records ─────────────────────────────────

UPDATE revenue_records
SET    is_orphan  = false,
       updated_at = now()
WHERE  type        = 'extension'
  AND  is_orphan   = true
  AND  sync_excluded = false
  AND  booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings WHERE booking_ref = revenue_records.booking_id
       );

-- ── Pass 2: unorphan rental records with valid booking_ref ───────────────────
-- Repairs any rental records incorrectly flagged by the old health-check bug
-- that queried the non-existent bookings.booking_id column.

UPDATE revenue_records
SET    is_orphan  = false,
       updated_at = now()
WHERE  type        = 'rental'
  AND  is_orphan   = true
  AND  sync_excluded = false
  AND  booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings WHERE booking_ref = revenue_records.booking_id
       );

-- ── Pass 3: refresh booking_revenue_grouped view ─────────────────────────────
-- Explicitly includes ALL record types (rental + extension + fee) in both the
-- records JSONB array and the gross_total aggregation.
-- No type filter is applied to the records column — the FILTER clause on the
-- extensions column is intentional and only affects that specific column.

CREATE OR REPLACE VIEW booking_revenue_grouped AS
SELECT
  COALESCE(original_booking_id, booking_id)             AS booking_group_id,
  MAX(vehicle_id)                                        AS vehicle_id,
  MAX(customer_name)                                     AS customer_name,
  MAX(customer_phone)                                    AS customer_phone,
  MAX(customer_email)                                    AS customer_email,
  MIN(pickup_date)                                       AS min_pickup_date,
  MAX(return_date)                                       AS max_return_date,
  -- gross_total: sum ALL record types (rental + extension + fee) that are not
  -- cancelled.  Do NOT add a type filter here — extensions must be included.
  COALESCE(
    SUM(gross_amount) FILTER (WHERE is_cancelled = false),
    0
  )                                                      AS gross_total,
  COUNT(*)                                               AS record_count,
  -- records: full detail for every row in the group — rental, extension, and
  -- fee rows alike.  The frontend splits them by type after receiving this.
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'customer_name',       customer_name,
      'customer_phone',      customer_phone,
      'customer_email',      customer_email,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'deposit_amount',      deposit_amount,
      'refund_amount',       refund_amount,
      'stripe_fee',          stripe_fee,
      'stripe_net',          stripe_net,
      'payment_method',      payment_method,
      'payment_status',      payment_status,
      'type',                type,
      'is_cancelled',        is_cancelled,
      'is_no_show',          is_no_show,
      'is_orphan',           is_orphan,
      'notes',               notes,
      'created_at',          created_at,
      'updated_at',          updated_at
    )
    ORDER BY created_at ASC
  )                                                      AS records,
  -- extensions: convenience column containing only extension rows for the
  -- group (used by some API paths that prefer a pre-filtered list).
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'stripe_fee',          stripe_fee,
      'payment_status',      payment_status,
      'type',                type,
      'created_at',          created_at
    )
    ORDER BY created_at ASC
  ) FILTER (WHERE type = 'extension')                    AS extensions
FROM revenue_records_effective
GROUP BY COALESCE(original_booking_id, booking_id);
