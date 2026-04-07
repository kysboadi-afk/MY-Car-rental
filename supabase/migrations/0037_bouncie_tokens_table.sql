-- =============================================================================
-- SLY RIDES — Migration 0037: Dedicated bouncie_tokens table
-- =============================================================================
--
-- Creates a first-class singleton table for Bouncie OAuth tokens.
-- Previously tokens were stored in the generic app_config table
-- (key = "bouncie_tokens").  This table makes the schema explicit,
-- avoids JSONB casting, and provides a clean upsert target for the
-- automatic token-refresh flow.
--
-- Columns:
--   id            — always 1 (singleton row, enforced by CHECK constraint)
--   access_token  — Bouncie OAuth 2.0 access token
--   refresh_token — Bouncie OAuth 2.0 refresh token
--   obtained_at   — when the current token pair was issued
--   updated_at    — last write timestamp
-- =============================================================================

CREATE TABLE IF NOT EXISTS bouncie_tokens (
  id            int         PRIMARY KEY DEFAULT 1,
  access_token  text,
  refresh_token text,
  obtained_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bouncie_tokens_single_row CHECK (id = 1)
);

-- Migrate any existing tokens from app_config (written by older bouncie-callback)
-- Only runs when the table is empty and app_config has a non-null access_token.
INSERT INTO bouncie_tokens (id, access_token, refresh_token, obtained_at, updated_at)
SELECT
  1,
  value->>'access_token',
  value->>'refresh_token',
  COALESCE((value->>'obtained_at')::timestamptz, now()),
  now()
FROM app_config
WHERE key = 'bouncie_tokens'
  AND (value->>'access_token') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM bouncie_tokens WHERE id = 1);
