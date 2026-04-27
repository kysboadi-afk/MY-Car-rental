-- Migration 0091: booking_revenue_grouped view
--
-- Groups revenue_records_effective by effective booking ID so the Revenue
-- Tracker always shows one row per booking with extensions collapsed inside.
--
-- Grouping key: COALESCE(original_booking_id, booking_id)
--   Extension rows store their parent booking ref in original_booking_id;
--   base rental rows use booking_id.  COALESCE merges them under one key.
--
-- Aggregation rules (per problem statement spec):
--   min_pickup_date  = MIN(pickup_date)
--   max_return_date  = MAX(return_date)
--   gross_total      = SUM(gross_amount) WHERE is_cancelled = false
--   extensions       = JSONB array of rows WHERE type = 'extension'
--   records          = JSONB array of ALL rows in the group (for detail view)
--
-- Scalar metadata (vehicle_id, customer_*) is taken from MAX() aggregation,
-- which reliably surfaces non-NULL values. In practice all rows in a booking
-- share the same vehicle and customer so MAX() returns the correct value.
--
-- Queries revenue_records_effective (sync_excluded = false already applied).
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW booking_revenue_grouped AS
SELECT
  COALESCE(original_booking_id, booking_id)             AS booking_group_id,
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
      'id',                   id,
      'booking_id',           booking_id,
      'original_booking_id',  original_booking_id,
      'vehicle_id',           vehicle_id,
      'customer_name',        customer_name,
      'customer_phone',       customer_phone,
      'customer_email',       customer_email,
      'pickup_date',          pickup_date,
      'return_date',          return_date,
      'gross_amount',         gross_amount,
      'stripe_fee',           stripe_fee,
      'stripe_net',           stripe_net,
      'refund_amount',        refund_amount,
      'deposit_amount',       deposit_amount,
      'payment_method',       payment_method,
      'payment_status',       payment_status,
      'is_cancelled',         is_cancelled,
      'is_no_show',           is_no_show,
      'type',                 type,
      'notes',                notes,
      'created_at',           created_at
    )
    ORDER BY created_at ASC
  )                                                      AS records,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                   id,
      'booking_id',           booking_id,
      'original_booking_id',  original_booking_id,
      'vehicle_id',           vehicle_id,
      'pickup_date',          pickup_date,
      'return_date',          return_date,
      'gross_amount',         gross_amount,
      'stripe_fee',           stripe_fee,
      'refund_amount',        refund_amount,
      'payment_method',       payment_method,
      'payment_status',       payment_status,
      'is_cancelled',         is_cancelled,
      'is_no_show',           is_no_show,
      'type',                 type
    )
    ORDER BY created_at ASC
  ) FILTER (WHERE type = 'extension')                    AS extensions
FROM revenue_records_effective
GROUP BY COALESCE(original_booking_id, booking_id);
