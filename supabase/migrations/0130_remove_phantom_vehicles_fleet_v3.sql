-- Migration 0130: Remove phantom vehicle rows (fleet v3 pass).
--
-- Context: migration 0129 ran with canonical fleet = (camry, camry2013, fusion2017).
-- A 4th vehicle row has since appeared in the Supabase vehicles table with
-- status = 'active', causing the admin_metrics_v2 "Available Vehicles" KPI to
-- display 4 instead of the correct 3.
--
-- The canonical fleet remains exactly three vehicles:
--   "camry", "camry2013", "fusion2017"
--
-- Fix strategy (mirrors migrations 0124 and 0129 with the same canonical set):
--   1. Hard-delete any vehicle row whose vehicle_id is NOT in the canonical set
--      AND that has no referencing bookings (no FK risk).
--   2. Soft-delete (set status = 'inactive') any remaining non-canonical rows
--      that still have booking history and therefore cannot be hard-deleted.
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
