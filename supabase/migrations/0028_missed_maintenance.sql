-- 0028_missed_maintenance.sql
-- Missed appointment tracking for the maintenance scheduling system.
--
-- Adds a missed_at column to maintenance_appointments so the cron job
-- (api/missed-maintenance.js) can record exactly when an appointment was
-- detected as missed.  The "missed" status string is handled in application
-- code; no constraint change is needed since status is plain text.
--
-- Also adds a composite index to speed up the per-vehicle+service missed-count
-- queries used for driver risk escalation.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

ALTER TABLE maintenance_appointments
  ADD COLUMN IF NOT EXISTS missed_at timestamptz;

-- Efficient lookup: overdue scheduled appointments (status + scheduled_at)
CREATE INDEX IF NOT EXISTS maint_appts_overdue_idx
  ON maintenance_appointments (status, scheduled_at)
  WHERE status = 'scheduled';

-- Efficient missed-count per booking (supports the (booking_id, status) filter in
-- missed-maintenance.js without relying on a partial index)
CREATE INDEX IF NOT EXISTS maint_appts_missed_booking_idx
  ON maintenance_appointments (booking_id, status);
