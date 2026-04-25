-- Migration 0053: add is_orphan column + create revenue_reporting_base view
--
-- Problem: v2-dashboard.js, v2-analytics.js, and v2-revenue.js all had their
-- own inline WHERE clauses against revenue_records_effective.  They each
-- repeated (or omitted) slightly different combinations of:
--   payment_status = 'paid'
--   sync_excluded  = false
--   is_orphan      = false
-- leading to subtle discrepancies between the Revenue page, Dashboard, and
-- Fleet Analytics totals.
--
-- Fix: introduce a single canonical view, revenue_reporting_base, that
-- centralises every shared filter in one place.  All three endpoints now
-- SELECT from this view and can add only their own run-time filters
-- (pickup_date range, vehicle_id, etc.) on top.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS and CREATE OR REPLACE VIEW are
-- idempotent.

-- ── 1. Add is_orphan column ───────────────────────────────────────────────────
-- Marks revenue_records rows that could not be linked to any known booking or
-- vehicle (e.g. stale Stripe charges from test-mode or deleted bookings).
-- The stripe-reconcile cleanup_orphans action will SET is_orphan = true on
-- unresolvable rows instead of sync_excluding them, so they remain visible
-- in admin audit queries but are excluded from financial reporting.

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS is_orphan boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS revenue_records_is_orphan_idx
  ON revenue_records (is_orphan)
  WHERE is_orphan = true;

-- ── 2. Create revenue_reporting_base view ─────────────────────────────────────
-- Canonical source for all financial reporting queries.
--
-- Filters applied here (never repeat these in JS):
--   • sync_excluded = false  — already guaranteed by source view
--                              (revenue_records_effective); included via COALESCE
--                              for self-documenting clarity
--   • payment_status = 'paid'
--   • is_orphan      = false — exclude Stripe charges with no matching booking
--
-- Filters intentionally left to JS:
--   • is_cancelled / is_no_show — revenue summary counts these separately;
--     dashboard/analytics skip them in the aggregation loop
--   • pickup_date range         — each endpoint applies its own date window
--   • vehicle_id                — fleet analytics filters per vehicle

CREATE OR REPLACE VIEW revenue_reporting_base AS
SELECT
  booking_id,
  vehicle_id,
  pickup_date,
  gross_amount,
  stripe_fee,
  stripe_net,
  refund_amount,
  deposit_amount,
  is_cancelled,
  is_no_show
FROM   revenue_records_effective
WHERE  payment_status              = 'paid'
  AND  COALESCE(sync_excluded,  false) = false
  AND  COALESCE(is_orphan,      false) = false;
