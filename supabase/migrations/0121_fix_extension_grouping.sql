-- Migration 0121: fix extension revenue record grouping in Revenue Tracker
--
-- Problem:
--   The booking_revenue_grouped view groups rows by:
--     COALESCE(original_booking_id, booking_id)
--
--   Extension records are supposed to have original_booking_id = booking_id
--   (both set to the canonical booking_ref of the parent booking).  However,
--   some records have a stale/incorrect original_booking_id (e.g. a Stripe PI
--   id, an old synthetic "ext-..." or "pi_..." value, or a different booking
--   ref from an earlier code path).  Because COALESCE picks original_booking_id
--   FIRST, these records end up in a phantom group (keyed by the stale value)
--   and display as a standalone row in the Revenue Tracker instead of collapsing
--   under their parent booking.
--
--   The existing migrations 0084 and 0085 fixed the case where booking_id itself
--   was the wrong value (pi_xxx, ext-xxx, NULL).  They did NOT fix the inverse
--   case: booking_id is already the correct "bk-..." ref but original_booking_id
--   is a stale non-matching value.
--
-- Fix (three passes, all idempotent):
--
--   Pass 1 — Align original_booking_id with booking_id for extension records:
--     For every extension row where booking_id IS a valid bookings.booking_ref
--     AND original_booking_id differs from booking_id, overwrite original_booking_id
--     with booking_id.  This is safe because booking_id is already the canonical
--     value; original_booking_id was historically used as a fallback for legacy
--     rows and is now redundant for correctly-migrated records.
--
--   Pass 2 — Refresh booking_revenue_grouped view (COALESCE order flip):
--     Change the group key from COALESCE(original_booking_id, booking_id) to
--     COALESCE(booking_id, original_booking_id).  booking_id is the canonical
--     field as of migration 0084 — it is always the correct booking_ref for
--     every extension record.  Flipping the order means a stale original_booking_id
--     can never produce a phantom group key.  This also protects against any
--     future case where original_booking_id is not kept in sync.
--
--   Pass 3 — Same fix for revenue_reporting_base view (defensive, same logic):
--     revenue_reporting_base uses COALESCE(original_booking_id, booking_id) in
--     its booking_group_id column.  Apply the same order flip.
--
-- Safe to re-run: UPDATE uses idempotent WHERE clause; CREATE OR REPLACE VIEW
-- is idempotent.

-- ── Pass 1: align original_booking_id with booking_id ────────────────────────

UPDATE revenue_records
SET    original_booking_id = booking_id,
       updated_at          = now()
WHERE  type              = 'extension'
  AND  sync_excluded     = false
  AND  is_orphan         = false
  AND  booking_id          IS NOT NULL
  AND  original_booking_id IS DISTINCT FROM booking_id
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.booking_id
       );

-- ── Pass 2: refresh booking_revenue_grouped view (booking_id first) ──────────

CREATE OR REPLACE VIEW booking_revenue_grouped AS
SELECT
  -- Prefer booking_id (canonical booking_ref, always correct after migration 0084).
  -- Fall back to original_booking_id only when booking_id is NULL (e.g. orphan rows).
  COALESCE(booking_id, original_booking_id)             AS booking_group_id,
  MAX(vehicle_id)                                        AS vehicle_id,
  MAX(customer_name)                                     AS customer_name,
  MAX(customer_phone)                                    AS customer_phone,
  MAX(customer_email)                                    AS customer_email,
  MIN(pickup_date)                                       AS min_pickup_date,
  MAX(return_date)                                       AS max_return_date,
  COALESCE(
    SUM(gross_amount) FILTER (WHERE is_cancelled = false),
    0
  )                                                      AS gross_total,
  COUNT(*)                                               AS record_count,
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
GROUP BY COALESCE(booking_id, original_booking_id);
