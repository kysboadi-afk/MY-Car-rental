-- Migration 0092: Normalize legacy "camry2012" vehicle_id to canonical "camry"
--
-- Some revenue records were manually inserted using the legacy vehicle ID
-- "camry2012" instead of the canonical "camry".  Because v2-revenue.js
-- filters by exact vehicle_id match, these records were invisible in the
-- Camry 2012 booking count on the Revenue and Admin pages.
--
-- After this migration all Camry 2012 records share the same vehicle_id
-- ("camry") and will be correctly counted and displayed together.

UPDATE revenue_records
SET vehicle_id = 'camry'
WHERE vehicle_id = 'camry2012';
