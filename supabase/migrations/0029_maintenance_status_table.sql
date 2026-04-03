-- 0029_maintenance_status_table.sql
-- Adds a dedicated maintenance status table for tracking scheduled/overdue services.
--
-- This table is the single source of truth for per-vehicle maintenance status
-- (oil, brakes, tires) with explicit due dates and lifecycle statuses.
-- The AI tool get_maintenance_status queries this table alongside
-- maintenance_history (completed events) and maintenance_appointments (driver-
-- scheduled appointments) to answer questions like "What's the maintenance
-- status of Camry 2013?"
--
-- Schema:
--   vehicle_id   TEXT  → matches vehicles.vehicle_id (e.g. "camry2013")
--   service_type TEXT  → 'oil' | 'brakes' | 'tires'
--   due_date     DATE  → when service is due
--   status       TEXT  → 'pending' | 'scheduled' | 'completed' | 'overdue'
--
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

-- ── maintenance ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance (
  id           BIGSERIAL    PRIMARY KEY,
  vehicle_id   TEXT         NOT NULL,   -- FK to vehicles.vehicle_id
  service_type TEXT         NOT NULL,   -- 'oil' | 'brakes' | 'tires'
  due_date     DATE,                    -- when service is due
  status       TEXT         NOT NULL DEFAULT 'pending',
  -- 'pending' = due soon, 'scheduled' = appointment exists,
  -- 'completed' = done, 'overdue' = past due_date and not completed
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns used by get_maintenance_status
CREATE INDEX IF NOT EXISTS maintenance_vehicle_idx     ON maintenance (vehicle_id);
CREATE INDEX IF NOT EXISTS maintenance_status_idx      ON maintenance (status);
CREATE INDEX IF NOT EXISTS maintenance_due_date_idx    ON maintenance (due_date);
CREATE INDEX IF NOT EXISTS maintenance_vehicle_type_idx ON maintenance (vehicle_id, service_type);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Service-role key (used by all API functions) bypasses RLS automatically.
-- Enable RLS to prevent direct anonymous reads, but allow the service role
-- full access (no explicit policy needed for service role).
ALTER TABLE maintenance ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated users (admin dashboard).
CREATE POLICY IF NOT EXISTS maintenance_select_authenticated
  ON maintenance FOR SELECT
  TO authenticated
  USING (true);
