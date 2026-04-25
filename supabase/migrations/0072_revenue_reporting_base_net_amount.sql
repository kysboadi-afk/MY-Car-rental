-- Migration 0072: extend revenue_reporting_base with net_amount and customer fields
--
-- Problem: revenue_reporting_base (migration 0053) was created with an explicit
-- column list that omits:
--   • net_amount       — the canonical pre-computed net (gross − refund_amount),
--                        stored as a GENERATED ALWAYS column on revenue_records.
--                        Consumer code had to recompute gross_amount − refund_amount
--                        in JavaScript instead of reading it directly.
--   • customer_phone   — required by v2-customers sync to identify the renter.
--   • customer_name    — required by v2-customers sync for display name.
--   • customer_email   — required by v2-customers sync as the primary identity key.
--   • return_date      — required by v2-customers sync to compute rental days.
--   • type             — revenue record type (rental / extension / fee); useful for
--                        auditing that all revenue types are included in totals.
--
-- Fix: replace the view with an updated definition that adds these columns.
-- All existing consumers (v2-analytics.js, v2-dashboard.js, v2-revenue.js) query
-- only a subset of columns and are unaffected by the additions.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW revenue_reporting_base AS
SELECT
  booking_id,
  vehicle_id,
  customer_name,
  customer_phone,
  customer_email,
  pickup_date,
  return_date,
  gross_amount,
  stripe_fee,
  stripe_net,
  refund_amount,
  net_amount,
  deposit_amount,
  type,
  is_cancelled,
  is_no_show
FROM   revenue_records_effective
WHERE  payment_status              = 'paid'
  AND  COALESCE(sync_excluded,  false) = false
  AND  COALESCE(is_orphan,      false) = false;
