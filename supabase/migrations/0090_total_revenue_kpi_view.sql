-- Migration 0090: total_revenue_kpi view
--
-- Provides a single, stable KPI value for total revenue that is:
--   • ledger-based — sums gross_amount directly from revenue_records
--   • independent of payment_intent_id / Stripe-specific fields
--   • inclusive of Stripe payments, manual/admin payments, and extensions
--
-- Definition matches the problem statement spec exactly:
--   SELECT SUM(gross_amount) FROM revenue_records WHERE is_cancelled = false
--
-- Note: queries revenue_records directly (not revenue_records_effective) so
-- sync_excluded rows are included. This is intentional — the KPI reflects
-- every recorded charge regardless of display exclusions.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW total_revenue_kpi AS
SELECT
  COALESCE(SUM(gross_amount), 0) AS total_revenue
FROM revenue_records
WHERE is_cancelled = false;
