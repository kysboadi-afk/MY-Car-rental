-- Migration 0142: Canonical revenue pipeline + reconciliation audit surface
--
-- Goal:
--   Ensure every admin financial surface derives from one canonical dataset.
--
-- Canonical inclusion rules:
--   payment_status = 'paid'
--   sync_excluded  = false
--   is_orphan      = false
--   is_cancelled   = false
--   is_no_show     = false
--
-- Notes:
--   • revenue_reporting_base already applies payment_status/sync_excluded/is_orphan.
--   • This migration adds the remaining is_cancelled/is_no_show filters in one place.
--   • The audit view preserves a reusable reconciliation query shape for diagnostics.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

-- Canonical row-level reporting source for all financial surfaces.
CREATE OR REPLACE VIEW revenue_reporting_canonical AS
SELECT
  booking_id,
  vehicle_id,
  customer_name,
  customer_phone,
  customer_email,
  pickup_date,
  return_date,
  gross_amount,
  COALESCE(stripe_fee, 0)                         AS stripe_fee,
  COALESCE(refund_amount, 0)                      AS refund_amount,
  (gross_amount - COALESCE(stripe_fee, 0) - COALESCE(refund_amount, 0))
                                                  AS canonical_net_amount,
  deposit_amount,
  payment_method,
  payment_status,
  type
FROM revenue_reporting_base
WHERE COALESCE(is_cancelled, false) = false
  AND COALESCE(is_no_show, false)   = false;

-- Canonical gross KPI (all fleets combined).
CREATE OR REPLACE VIEW total_revenue_kpi_canonical AS
SELECT COALESCE(SUM(gross_amount), 0) AS total_revenue
FROM revenue_reporting_canonical;

-- Reconciliation audit surface (preserved diagnostic artifact).
-- Includes raw ledger rows and supplemental charges in one report shape.
CREATE OR REPLACE VIEW revenue_reconciliation_audit AS
WITH rr AS (
  SELECT
    rr.booking_id,
    rr.payment_intent_id,
    COALESCE(rr.gross_amount, 0)::numeric         AS gross,
    COALESCE(rr.stripe_fee, 0)::numeric           AS fees,
    COALESCE(rr.refund_amount, 0)::numeric        AS refunds,
    (COALESCE(rr.gross_amount, 0)
      - COALESCE(rr.stripe_fee, 0)
      - COALESCE(rr.refund_amount, 0))::numeric   AS net,
    'revenue_records'::text                        AS source_table,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_dashboard,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_revenue_page,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_fleet_analytics
  FROM revenue_records rr
),
charges_only AS (
  SELECT
    c.booking_id,
    c.stripe_payment_intent_id                       AS payment_intent_id,
    COALESCE(c.amount, 0)::numeric                   AS gross,
    0::numeric                                       AS fees,
    0::numeric                                       AS refunds,
    COALESCE(c.amount, 0)::numeric                   AS net,
    'charges'::text                                  AS source_table,
    false                                            AS included_in_dashboard,
    false                                            AS included_in_revenue_page,
    false                                            AS included_in_fleet_analytics
  FROM charges c
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
