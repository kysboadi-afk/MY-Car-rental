-- Migration 0074: Add metadata column to sms_logs
--
-- Purpose:
-- Adds a `metadata` jsonb column to the sms_logs table so the scheduler
-- and SMS handlers can store extra context alongside each logged message.
--
-- Primary use cases:
--   • Link validation: record {link, validated, status} so we know whether
--     the payment link in an SMS was reachable at send time and, if not,
--     which fallback URL was sent instead.
--   • Future: store rendered message length, delivery status, retry count, …
--
-- The column is nullable and has no schema enforcement so callers can evolve
-- what they store without needing further migrations.

ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN sms_logs.metadata IS 'Optional structured context for the SMS (e.g. {link, validated, status, fallback_used}). Null for legacy rows.';
