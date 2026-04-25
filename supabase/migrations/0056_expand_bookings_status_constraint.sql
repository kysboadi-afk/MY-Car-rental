-- Migration 0056: Expand bookings.status allowed values
--
-- Purpose:
-- Replace bookings_status_check so booking lifecycle supports:
--   pending, active, overdue, completed
-- Normalize legacy statuses before enforcing the new check:
--   approved  -> pending
--   cancelled -> completed

UPDATE bookings
SET status = 'pending'
WHERE status = 'approved';

UPDATE bookings
SET status = 'completed'
WHERE status = 'cancelled';

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'active', 'overdue', 'completed'));
