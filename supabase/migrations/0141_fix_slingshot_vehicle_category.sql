-- Migration 0141: Backfill correct category for slingshot vehicles.
--
-- Root cause: slingshot vehicles could be saved with data.category = 'car'
-- (or no category at all) when they were created or edited through admin
-- portals that did not explicitly send category:'slingshot'.  The
-- deriveVehicleCategory helper in admin-ai-insights returns the explicit
-- category value first, so a stored 'car' value overrides all name/type/id
-- fallback checks — causing slingshot vehicles to pass the car scope filter
-- and appear in the car admin's "Detected Problems" panel.
--
-- Fix strategy:
--   For every vehicle row where any of the canonical slingshot signals is
--   present (vehicle_id starts with 'slingshot', data->>'type' is 'slingshot',
--   or data->>'vehicle_name' contains 'slingshot' case-insensitively), force
--   data.category to 'slingshot'.
--
-- Safe to re-run: the WHERE clause is idempotent.

UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{category}', '"slingshot"')
WHERE (
    vehicle_id ILIKE 'slingshot%'
    OR data->>'type' = 'slingshot'
    OR lower(data->>'vehicle_name') LIKE '%slingshot%'
)
  AND (data->>'category' IS NULL OR data->>'category' != 'slingshot');
