-- Migration 0056: Expand bookings.status allowed values
--
-- Purpose:
-- Replace bookings_status_check so booking lifecycle supports:
--   pending, active, overdue, completed

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'active', 'overdue', 'completed'));
