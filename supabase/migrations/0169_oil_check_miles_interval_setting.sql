-- =============================================================================
-- Migration 0169: oil_check_miles_interval system setting
-- =============================================================================
--
-- Seeds the admin-configurable threshold (miles since last oil check before an
-- oil-check SMS is dispatched to the active renter).  The default of 500 matches
-- the previous hardcoded constant in api/oil-check-cron.js.
--
-- Safe to re-run: ON CONFLICT DO NOTHING skips the insert when the row exists
-- so a subsequent re-run or a fresh seed does not overwrite admin customisations.
-- =============================================================================

INSERT INTO system_settings (key, value, description, category, updated_at, updated_by)
VALUES (
  'oil_check_miles_interval',
  '500'::jsonb,
  'Miles driven since last oil check before an oil-check SMS is sent to the active renter (default: 500)',
  'maintenance',
  now(),
  'system'
)
ON CONFLICT (key) DO NOTHING;
