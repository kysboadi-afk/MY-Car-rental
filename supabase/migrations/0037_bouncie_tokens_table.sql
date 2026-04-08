-- 0037_bouncie_tokens_table.sql
-- Bouncie OAuth token storage.
--
-- Stores the singleton OAuth token (id=1) used by the Bouncie GPS integration.
-- Tokens are exchanged via /api/bouncie-callback and auto-refreshed on 401.

create table if not exists bouncie_tokens (
  id            int           primary key,
  access_token  text,
  refresh_token text,
  obtained_at   timestamptz,
  updated_at    timestamptz
);
