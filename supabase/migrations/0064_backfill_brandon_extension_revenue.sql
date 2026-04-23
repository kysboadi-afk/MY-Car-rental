-- Migration 0064: backfill missing Brandon extension revenue row
--
-- Required one-off recovery:
--   payment_intent_id = pi_3TP2RQPo7fICjrtZ26LarkgC
--   booking_id        = ca8ee28ffb888c41
--   type              = extension
--   gross_amount      = 60.64
--   stripe_fee        = 2.06
--   stripe_net        = 58.58
--
-- Important:
--   • Inserts a NEW revenue_records row (no update/merge of existing rental row).
--   • Uses payment_intent_id for deduplication.
--   • Safe to re-run (NOT EXISTS guard on payment_intent_id).

WITH target AS (
  SELECT
    'ca8ee28ffb888c41'::text              AS booking_id,
    'pi_3TP2RQPo7fICjrtZ26LarkgC'::text   AS payment_intent_id,
    60.64::numeric(10,2)                  AS gross_amount,
    2.06::numeric(10,2)                   AS stripe_fee,
    58.58::numeric(10,2)                  AS stripe_net
),
context AS (
  SELECT
    t.booking_id,
    t.payment_intent_id,
    t.gross_amount,
    t.stripe_fee,
    t.stripe_net,
    COALESCE(
      (
        SELECT rr.vehicle_id
        FROM revenue_records rr
        WHERE rr.booking_id = t.booking_id
        ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
        LIMIT 1
      ),
      (
        SELECT b.vehicle_id
        FROM bookings b
        WHERE b.booking_ref = t.booking_id
        ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC NULLS LAST
        LIMIT 1
      )
    ) AS vehicle_id,
    (
      SELECT rr.customer_id
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_id,
    (
      SELECT rr.customer_name
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_name,
    (
      SELECT rr.customer_phone
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_phone,
    (
      SELECT rr.customer_email
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_email
  FROM target t
)
INSERT INTO revenue_records (
  booking_id,
  original_booking_id,
  payment_intent_id,
  vehicle_id,
  customer_id,
  customer_name,
  customer_phone,
  customer_email,
  gross_amount,
  payment_method,
  payment_status,
  type,
  stripe_fee,
  stripe_net,
  notes
)
SELECT
  c.booking_id,
  c.booking_id AS original_booking_id,
  c.payment_intent_id,
  c.vehicle_id,
  c.customer_id,
  c.customer_name,
  c.customer_phone,
  c.customer_email,
  c.gross_amount,
  'stripe' AS payment_method,
  'paid'   AS payment_status,
  'extension' AS type,
  c.stripe_fee,
  c.stripe_net,
  'Backfill: missing extension revenue row for PI pi_3TP2RQPo7fICjrtZ26LarkgC' AS notes
FROM context c
WHERE c.vehicle_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM revenue_records rr
    WHERE rr.payment_intent_id = c.payment_intent_id
  );
