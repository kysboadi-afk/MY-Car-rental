-- Migration 0143: Add vehicle_id to revenue_reconciliation_audit view
--
-- Extends the reconciliation audit view from 0142 to include vehicle_id for
-- per-vehicle diagnostics and API filtering by the v2-revenue-reconciliation
-- endpoint.  The charges CTE pulls vehicle_id via the bookings table join so
-- unlinked charges still appear (with a NULL vehicle_id).
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW revenue_reconciliation_audit AS
WITH rr AS (
  SELECT
    rr.booking_id,
    rr.vehicle_id,
    rr.payment_intent_id,
    COALESCE(rr.gross_amount, 0)::numeric          AS gross,
    COALESCE(rr.stripe_fee, 0)::numeric            AS fees,
    COALESCE(rr.refund_amount, 0)::numeric         AS refunds,
    (COALESCE(rr.gross_amount, 0)
      - COALESCE(rr.stripe_fee, 0)
      - COALESCE(rr.refund_amount, 0))::numeric    AS net,
    'revenue_records'::text                         AS source_table,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_dashboard,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_revenue_page,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_fleet_analytics
  FROM revenue_records rr
),
charges_only AS (
  SELECT
    c.booking_id,
    b.vehicle_id,
    c.stripe_payment_intent_id                        AS payment_intent_id,
    COALESCE(c.amount, 0)::numeric                    AS gross,
    0::numeric                                        AS fees,
    0::numeric                                        AS refunds,
    COALESCE(c.amount, 0)::numeric                    AS net,
    'charges'::text                                   AS source_table,
    false                                             AS included_in_dashboard,
    false                                             AS included_in_revenue_page,
    false                                             AS included_in_fleet_analytics
  FROM charges c
  LEFT JOIN bookings b ON b.booking_ref = c.booking_id
  WHERE c.status = 'succeeded'
    AND (
      c.stripe_payment_intent_id IS NULL
      OR c.stripe_payment_intent_id NOT IN (
        SELECT payment_intent_id
        FROM revenue_records
        WHERE payment_intent_id IS NOT NULL
      )
    )
)
SELECT * FROM rr
UNION ALL
SELECT * FROM charges_only;
