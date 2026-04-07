-- =============================================================================
-- SLY RIDES — Migration 0034: Clear all camry2013 blocked_dates rows
-- =============================================================================
--
-- What this migration does:
--   Removes every entry in the blocked_dates table for vehicle_id = 'camry2013'.
--   These rows were created automatically when bookings were confirmed and when
--   the admin manually added blocks.  They have been cleared from booked-dates.json
--   (GitHub) already; this migration brings the Supabase store into sync so that
--   the admin AI assistant's get_blocked_dates tool also shows no blocks for the
--   Camry 2013 SE.
--
-- Safe to re-run: DELETE WHERE is idempotent once the rows are gone.
-- =============================================================================

DELETE FROM blocked_dates
WHERE vehicle_id = 'camry2013';
