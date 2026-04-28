-- Migration 0102: Add provider_id column to sms_delivery_logs
--
-- Purpose:
-- Adds a provider_id column to capture the message/session ID returned by the
-- SMS provider (TextMagic) when a message is successfully accepted.  This
-- allows correlating delivery logs with provider dashboards and delivery
-- receipt webhooks for end-to-end traceability.
--
-- The column is nullable: 'failed' and 'skipped' rows will have NULL here;
-- 'sent' rows will carry the TextMagic session id (top-level "id" field in the
-- POST /api/v2/messages response).

ALTER TABLE sms_delivery_logs ADD COLUMN IF NOT EXISTS provider_id TEXT;

COMMENT ON COLUMN sms_delivery_logs.provider_id IS 'SMS provider message/session ID (e.g. TextMagic session id). Null for failed/skipped rows.';
