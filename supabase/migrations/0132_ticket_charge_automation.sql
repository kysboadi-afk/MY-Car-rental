-- Migration 0132: Ticket charge automation (Part 3)
--
-- Changes:
--   1. tickets: add charge_retry_count, charge_last_attempted_at
--   2. system_settings: seed violation_admin_fee key (if not present)

-- ── 1. tickets table: retry tracking columns ─────────────────────────────────
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS charge_retry_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_last_attempted_at timestamptz;

-- ── 2. system_settings: seed violation_admin_fee ─────────────────────────────
-- Only inserts if the key does not already exist to keep this idempotent.
INSERT INTO system_settings (key, value, description, category)
VALUES (
  'violation_admin_fee',
  '25',
  'Admin processing fee added to violation ticket charge (USD)',
  'fees'
)
ON CONFLICT (key) DO NOTHING;
