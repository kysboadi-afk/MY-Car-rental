-- =============================================================================
-- Migration 0079: Oil Check Compliance System
-- =============================================================================
--
-- Adds oil check tracking columns to the bookings table and creates a new
-- vehicle_state table that persists per-vehicle oil check state across
-- multiple renters.
--
-- Safe to re-run: all statements are guarded with IF NOT EXISTS or
-- ADD COLUMN IF NOT EXISTS.
-- =============================================================================


-- ── Bookings: oil check tracking columns ─────────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS last_oil_check_at       timestamptz,
  ADD COLUMN IF NOT EXISTS oil_status              text,
  ADD COLUMN IF NOT EXISTS oil_check_required      boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oil_check_last_request  timestamptz,
  ADD COLUMN IF NOT EXISTS oil_check_missed_count  integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS oil_check_photo_url     text;

DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_oil_status_check
    CHECK (oil_status IN ('full', 'mid', 'low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── vehicle_state table ───────────────────────────────────────────────────────
-- One row per vehicle.  Tracks oil check state across renters so history is
-- preserved even when a new booking starts on the same vehicle.

CREATE TABLE IF NOT EXISTS vehicle_state (
  vehicle_id              text        PRIMARY KEY REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  last_oil_check_at       timestamptz,
  last_oil_status         text,
  last_oil_check_photo_url text,
  last_oil_check_mileage  numeric(10,2),
  current_mileage         numeric(10,2),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE vehicle_state
    ADD CONSTRAINT vehicle_state_oil_status_check
    CHECK (last_oil_status IN ('full', 'mid', 'low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed a row for every existing vehicle so vehicle_state always has coverage.
INSERT INTO vehicle_state (vehicle_id)
SELECT vehicle_id FROM vehicles
ON CONFLICT (vehicle_id) DO NOTHING;

-- Keep updated_at current on every write.
CREATE OR REPLACE FUNCTION vehicle_state_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicle_state_updated_at ON vehicle_state;
CREATE TRIGGER vehicle_state_updated_at
  BEFORE UPDATE ON vehicle_state
  FOR EACH ROW EXECUTE FUNCTION vehicle_state_set_updated_at();
