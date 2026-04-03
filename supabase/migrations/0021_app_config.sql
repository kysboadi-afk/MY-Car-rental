-- 0021_app_config.sql
-- Generic key-value store for server-side application configuration.
-- Used by the Bouncie integration to persist OAuth tokens so they can be
-- refreshed automatically without redeploying Vercel env vars.
--
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

-- Seed a placeholder row for Bouncie tokens so the upsert path always works
-- (the actual tokens are written by /api/bouncie-auth at first-time setup).
insert into app_config (key, value)
values ('bouncie_tokens', '{"access_token":null,"refresh_token":null}'::jsonb)
on conflict (key) do nothing;
