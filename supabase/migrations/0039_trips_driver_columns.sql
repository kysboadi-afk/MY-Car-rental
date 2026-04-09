-- 0039_trips_driver_columns.sql
-- Driver mileage tracking: denormalize driver info onto the trips table for
-- fast per-driver reporting without always joining through the bookings JSON.
--
-- New columns on trips:
--   driver_name  TEXT  — customer name from the booking record
--   driver_phone TEXT  — normalized E.164 phone from the booking record
--
-- The booking_id foreign key is TEXT that matches bookings.booking_ref (or
-- the legacy bookings.json bookingId). A backfill JOIN against the Supabase
-- bookings table populates rows that were inserted before this migration.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.

-- ── trips — add driver columns ────────────────────────────────────────────────
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS driver_name  TEXT,
  ADD COLUMN IF NOT EXISTS driver_phone TEXT;

-- Index for fast per-driver queries with date filtering
CREATE INDEX IF NOT EXISTS trips_driver_phone_at_idx
  ON trips (driver_phone, created_at DESC)
  WHERE driver_phone IS NOT NULL;

-- ── Backfill from the normalised Supabase bookings table ─────────────────────
-- Joins on booking_id (trips) ↔ booking_ref (bookings).
-- Only fills rows where the columns are still NULL to remain idempotent.
UPDATE trips t
SET
  driver_name  = b.customer_name,
  driver_phone = b.customer_phone
FROM bookings b
WHERE t.booking_id = b.booking_ref
  AND (t.driver_name IS NULL OR t.driver_phone IS NULL);
