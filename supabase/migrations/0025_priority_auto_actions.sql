-- 0025_priority_auto_actions.sql
-- Priority-based auto-alert deduplication columns.
--
-- These columns are written by the admin-ai-auto cron job after it fires an
-- owner alert or driver message for a high-priority vehicle.  They are used
-- to prevent the same alert from being sent on every cron cycle.
--
-- last_auto_action_at     — ISO timestamp of the last auto-alert sent
-- last_auto_action_reason — the priority_reason string at the time of the
--                           alert (e.g. "Maintenance overdue: oil change").
--                           When the reason changes, a new alert is warranted.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.

alter table vehicles
  add column if not exists last_auto_action_at     timestamptz,
  add column if not exists last_auto_action_reason text;

create index if not exists vehicles_last_auto_action_idx
  on vehicles (last_auto_action_at desc nulls last);
