-- Migration 0078: admin_metrics_v2 view
--
-- Provides a single-row view of the three core KPIs used by the AI automation
-- loop and any future callers that need a quick metrics snapshot:
--
--   revenue_this_week   — gross revenue from paid records whose pickup_date falls
--                         in the current ISO week (Monday–Sunday) in LA time.
--   revenue_this_month  — gross revenue from paid records whose pickup_date falls
--                         in the current calendar month in LA time.
--   active_rentals      — count of bookings currently in active status
--                         (status = 'active' or the denormalized 'active_rental').
--
-- Revenue is sourced from revenue_records_effective (excludes sync_excluded rows)
-- filtered to payment_status = 'paid', excluding cancelled / no-show records.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW admin_metrics_v2 AS
WITH la_bounds AS (
  SELECT
    date_trunc('week',  (now() AT TIME ZONE 'America/Los_Angeles')::date)::date                    AS week_start,
    (date_trunc('week', (now() AT TIME ZONE 'America/Los_Angeles')::date) + INTERVAL '7 days')::date AS week_end,
    date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')::date)::date                    AS month_start,
    (date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')::date) + INTERVAL '1 month')::date AS month_end
)
SELECT
  COALESCE(SUM(CASE
    WHEN rr.pickup_date >= lb.week_start  AND rr.pickup_date < lb.week_end
    THEN rr.gross_amount ELSE 0
  END), 0)::numeric(10,2) AS revenue_this_week,

  COALESCE(SUM(CASE
    WHEN rr.pickup_date >= lb.month_start AND rr.pickup_date < lb.month_end
    THEN rr.gross_amount ELSE 0
  END), 0)::numeric(10,2) AS revenue_this_month,

  (
    SELECT COUNT(*)::int
    FROM   bookings
    WHERE  status IN ('active', 'active_rental')
  ) AS active_rentals

FROM revenue_records_effective rr, la_bounds lb
WHERE rr.payment_status = 'paid'
  AND NOT COALESCE(rr.is_cancelled, false)
  AND NOT COALESCE(rr.is_no_show,   false);
