-- Migration 0089: Backfill revenue_records for paid bookings missing a revenue row.
--
-- Invariant: every booking with deposit_paid > 0 (i.e. at least one payment was
-- received) must have exactly one revenue_records row with type = 'rental'.
--
-- Note: deposit_paid is used as gross_amount because it is the actual amount
-- collected from the customer.  For most bookings deposit_paid == total_price
-- (full payments); for reservation-deposit bookings it holds the partial amount
-- paid, which is the correct value for a gross_amount revenue entry.
--
-- We insert only when ALL of:
--   • deposit_paid > 0
--   • booking is not cancelled (status NOT IN ('cancelled', 'cancelled_rental'))
--   • no rental revenue_records row already exists keyed by booking_ref (booking_id)
--   • if the booking has a payment_intent_id, no row with that same PI already
--     exists in revenue_records (prevents duplicate entries for bookings that were
--     recorded under a different booking_id by stripe-reconcile / early orphan logic)
--
-- Cash/manual bookings (payment_method IN ('cash','zelle','venmo','manual','external'))
-- receive stripe_fee = 0, stripe_net = gross_amount immediately so that analytics are
-- correct without waiting for a Stripe reconciliation pass.
-- All other bookings receive stripe_fee = NULL / stripe_net = NULL, to be filled in
-- later by stripe-reconcile.js.
--
-- Safe to re-run: the NOT EXISTS guards + ON CONFLICT DO NOTHING make this idempotent.

INSERT INTO revenue_records (
  booking_id,
  payment_intent_id,
  vehicle_id,
  pickup_date,
  return_date,
  gross_amount,
  deposit_amount,
  refund_amount,
  payment_method,
  payment_status,
  type,
  is_no_show,
  is_cancelled,
  override_by_admin,
  stripe_fee,
  stripe_net
)
SELECT
  b.booking_ref,
  b.payment_intent_id,
  b.vehicle_id,
  b.pickup_date,
  b.return_date,
  b.deposit_paid                         AS gross_amount,
  0                                      AS deposit_amount,
  0                                      AS refund_amount,
  COALESCE(b.payment_method, 'stripe')   AS payment_method,
  'paid'                                 AS payment_status,
  'rental'                               AS type,
  false                                  AS is_no_show,
  false                                  AS is_cancelled,
  false                                  AS override_by_admin,
  -- Cash/offline payments: fee = 0, net = gross (no Stripe involvement)
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN 0
    ELSE NULL
  END                                    AS stripe_fee,
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN b.deposit_paid
    ELSE NULL
  END                                    AS stripe_net
FROM bookings b
WHERE
  -- Only bookings where money was actually collected
  b.deposit_paid > 0
  -- Skip cancelled bookings
  AND b.status NOT IN ('cancelled', 'cancelled_rental')
  -- Skip if a rental revenue record already exists for this booking
  AND NOT EXISTS (
    SELECT 1
    FROM   revenue_records rr
    WHERE  rr.booking_id = b.booking_ref
      AND  rr.type = 'rental'
  )
  -- Skip if the booking's payment_intent_id is already covered by another revenue row
  -- (e.g. an orphan record created by stripe-reconcile before the booking was linked)
  AND (
    b.payment_intent_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM   revenue_records rr2
      WHERE  rr2.payment_intent_id = b.payment_intent_id
    )
  )
ON CONFLICT DO NOTHING;
