-- 0021_app_config.sql
-- Generic key-value store for server-side application configuration.
-- Other integrations may use this table for any server-side config that
-- should not be hardcoded or stored only in env vars.
--
-- Safe to re-run: uses IF NOT EXISTS guards.

create table if not exists app_config (
  key        text        primary key,
  value      jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
