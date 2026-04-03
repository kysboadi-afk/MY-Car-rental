-- 0030_vehicle_tracking_and_trips.sql
-- Smart fleet tracking phase 2: vehicle tracking columns + booking-linked trips table.
--
-- New columns on vehicles:
--   is_tracked          BOOLEAN    — true when this vehicle should be monitored by the
--                                    maintenance auto-checker (updateMaintenanceStatus).
--   maintenance_interval INTEGER   — miles between general services (default 5000).
--                                    Used by updateMaintenanceStatus to derive OK/DUE_SOON/OVERDUE.
--
-- Note: current_mileage is stored in the existing `mileage` column (added by
-- migration 0020 for Bouncie sync). last_service_mileage is already stored in
-- the JSONB `data` blob. No duplicate columns are added.
--
-- New table: trips
--   Booking-linked trip records. One row per completed booking per vehicle.
--   Distinct from trip_log (0020) which stores individual GPS-based Bouncie events.
--   trips records the aggregate: total distance driven during a single rental period.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.

-- ── vehicles — add tracking columns ──────────────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS is_tracked           BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maintenance_interval INTEGER   NOT NULL DEFAULT 5000;

-- Index for fast lookup of all tracked vehicles (used by updateMaintenanceStatus cron).
CREATE INDEX IF NOT EXISTS vehicles_is_tracked_idx ON vehicles (is_tracked) WHERE is_tracked = true;

-- ── trips (booking-linked aggregate trip records) ─────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
  id              BIGSERIAL     PRIMARY KEY,
  vehicle_id      TEXT          NOT NULL,       -- matches vehicles.vehicle_id
  booking_id      TEXT,                         -- matches bookings.booking_id
  start_mileage   NUMERIC(10,1),               -- odometer at booking start
  end_mileage     NUMERIC(10,1),               -- odometer at booking end
  distance        NUMERIC(10,1),               -- miles driven (end - start, or sum of GPS trips)
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trips_vehicle_idx    ON trips (vehicle_id);
CREATE INDEX IF NOT EXISTS trips_booking_idx    ON trips (booking_id);
CREATE INDEX IF NOT EXISTS trips_created_idx    ON trips (created_at DESC);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS trips_select_authenticated
  ON trips FOR SELECT
  TO authenticated
  USING (true);
