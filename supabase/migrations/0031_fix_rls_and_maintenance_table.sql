-- 0031_fix_rls_and_maintenance_table.sql
-- Fixes two gaps between the migration files and the actual database state:
--
-- Gap 1 — missing maintenance table
--   Migration 0029 (maintenance_status_table) was never applied to the database.
--   public.maintenance does not exist; this migration creates it.
--
-- Gap 2 — missing RLS on maintenance_history and maintenance_appointments
--   Migrations 0023 and 0027 created these tables without enabling RLS.
--   Both tables have rls_enabled = false in the current database, meaning any
--   Supabase anonymous or authenticated client can read them directly.
--   This migration enables RLS and adds a read policy for authenticated users,
--   matching the pattern used by migrations 0029 and 0030.
--
-- All statements are safe to re-run (IF NOT EXISTS / idempotent ALTER).

-- ── maintenance (from 0029, never applied) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance (
  id           BIGSERIAL    PRIMARY KEY,
  vehicle_id   TEXT         NOT NULL,   -- FK to vehicles.vehicle_id (e.g. "camry2013")
  service_type TEXT         NOT NULL,   -- 'oil' | 'brakes' | 'tires'
  due_date     DATE,                    -- when service is due
  status       TEXT         NOT NULL DEFAULT 'pending',
  -- 'pending' = due soon, 'scheduled' = appointment exists,
  -- 'completed' = done, 'overdue' = past due_date and not completed
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS maintenance_vehicle_idx      ON maintenance (vehicle_id);
CREATE INDEX IF NOT EXISTS maintenance_status_idx       ON maintenance (status);
CREATE INDEX IF NOT EXISTS maintenance_due_date_idx     ON maintenance (due_date);
CREATE INDEX IF NOT EXISTS maintenance_vehicle_type_idx ON maintenance (vehicle_id, service_type);

ALTER TABLE maintenance ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS maintenance_select_authenticated
  ON maintenance FOR SELECT
  TO authenticated
  USING (true);

-- ── maintenance_history (RLS was never enabled) ───────────────────────────────
-- Service-role key (used by all API functions) bypasses RLS automatically.
-- Enable RLS so anonymous clients cannot read service history directly.
ALTER TABLE maintenance_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS maintenance_history_select_authenticated
  ON maintenance_history FOR SELECT
  TO authenticated
  USING (true);

-- ── maintenance_appointments (RLS was never enabled) ──────────────────────────
ALTER TABLE maintenance_appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS maintenance_appointments_select_authenticated
  ON maintenance_appointments FOR SELECT
  TO authenticated
  USING (true);
