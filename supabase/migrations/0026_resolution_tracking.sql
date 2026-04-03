-- 0026_resolution_tracking.sql
-- Resolution feedback columns for the priority auto-action system.
--
-- When a vehicle's action_status transitions to "resolved" (via the
-- update_action_status AI tool or the toolMarkMaintenance auto-resolve path),
-- these columns capture the closure of that alert cycle:
--
--   last_resolved_at     — timestamp of the resolution
--   last_resolved_reason — the priority_reason that was active when the alert
--                          was originally fired (copied from last_auto_action_reason
--                          at the moment of resolution)
--
-- Dedup reset: on resolution the cron code also clears last_auto_action_at and
-- last_auto_action_reason (added in migration 0025).  This allows the same issue
-- to re-trigger a new alert if it reoccurs after being resolved, while still
-- preventing redundant alerts within an unresolved cycle.
--
-- Analytics: time_to_resolution can be derived as:
--   last_resolved_at - last_auto_action_at
-- (last_auto_action_at is cleared on resolution, so callers should capture it
--  before the reset if they need the exact delta — the return value of the
--  update_action_status tool includes time_to_resolution_ms for this purpose.)
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.

alter table vehicles
  add column if not exists last_resolved_at     timestamptz,
  add column if not exists last_resolved_reason text;

create index if not exists vehicles_last_resolved_idx
  on vehicles (last_resolved_at desc nulls last);
