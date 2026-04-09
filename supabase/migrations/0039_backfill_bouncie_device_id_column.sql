-- 0039_backfill_bouncie_device_id_column.sql
-- Data-correction migration: copy bouncie_device_id from the data JSONB blob
-- into the dedicated bouncie_device_id column for any vehicle where the column
-- is currently NULL but the JSONB carries the IMEI.
--
-- Background:
--   Migration 0020 added the bouncie_device_id column and seeded camry2013.
--   If a vehicle's IMEI was ever written only via the legacy JSONB path (or if
--   the column was accidentally cleared), it will be invisible to every query
--   that filters on the column (maintenance-alerts, v2-mileage GET, admin-chat
--   mileage/maintenance tools, admin-ai-insights). This migration permanently
--   corrects the data so all code paths work without JSONB fallbacks.
--
-- Also sets is_tracked = true for any backfilled row, because a vehicle with
-- a Bouncie IMEI is by definition tracked (migration 0038 already did this for
-- rows whose column was already set, but could not help rows whose column was
-- NULL even though the JSONB had a value).

UPDATE vehicles
SET
  bouncie_device_id = (data->>'bouncie_device_id'),
  is_tracked        = true
WHERE
  bouncie_device_id IS NULL
  AND data->>'bouncie_device_id' IS NOT NULL
  AND data->>'bouncie_device_id' <> '';
