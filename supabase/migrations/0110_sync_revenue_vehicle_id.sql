-- Migration 0110: Normalise legacy "camry2012" vehicle_id to canonical "camry"
--                 across ALL tables that carry a vehicle_id column.
--
-- Background:
--   Before normalisation was enforced in the application layer, the Stripe webhook
--   derived a vehicle_id from the payment metadata vehicle_name ("Camry 2012") and
--   stored it verbatim as "camry2012".  Migration 0092 already normalised
--   revenue_records, but the bookings, blocked_dates, and expenses tables were
--   not updated at that time.
--
--   The canonical vehicle_id for Camry 2012 is "camry" (as registered in the
--   vehicles table and in _pricing.js CARS).  There is NO "camry2012" entry in the
--   vehicles table.  All code now uses FLEET_VEHICLE_IDS = ['camry', 'camry2013'],
--   so any row still holding "camry2012" is invisible to filters and aggregations.
--
-- Fix:
--   Update every table where vehicle_id = 'camry2012' → 'camry'.
--   The WHERE clause is a no-op when no stale rows exist, so this migration is
--   safe to re-run.

-- ── bookings ──────────────────────────────────────────────────────────────────
UPDATE bookings
SET    vehicle_id = 'camry',
       updated_at = now()
WHERE  vehicle_id = 'camry2012';

-- ── revenue_records ──────────────────────────────────────────────────────────
-- 0092 already normalised most rows; this catches any that were re-introduced.
UPDATE revenue_records
SET    vehicle_id = 'camry',
       updated_at = now()
WHERE  vehicle_id = 'camry2012';

-- ── blocked_dates ────────────────────────────────────────────────────────────
UPDATE blocked_dates
SET    vehicle_id = 'camry'
WHERE  vehicle_id = 'camry2012';

-- ── expenses ─────────────────────────────────────────────────────────────────
UPDATE expenses
SET    vehicle_id = 'camry'
WHERE  vehicle_id = 'camry2012';
