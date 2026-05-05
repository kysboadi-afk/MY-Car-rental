-- Migration 0129: Remove phantom vehicle rows now that the canonical fleet is
-- camry + camry2013 + fusion2017 (three vehicles).
--
-- Context: migration 0124 used ('camry', 'camry2013') as the canonical set.
-- fusion2017 was added to the fleet after 0124 ran, and any other phantom rows
-- (e.g. a test vehicle, a mis-typed ID, or a failed admin-UI create) may still
-- exist in the vehicles table with status = 'active', inflating the
-- admin_metrics_v2 available-vehicles count.
--
-- Fix strategy (mirrors migration 0124 with the updated canonical set):
--   1. Hard-delete any vehicle row whose vehicle_id is NOT in the canonical set
--      AND that has no referencing bookings.
--   2. Soft-delete (set status = 'inactive') any remaining non-canonical rows
--      that have booking history and therefore cannot be hard-deleted.
--
-- Safe to re-run: both statements are idempotent.

-- Step 1: hard-delete stale rows with no booking history
DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

-- Step 2: soft-delete for rows that still have booking history
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );
