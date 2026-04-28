-- Migration 0103: Ensure sms_delivery_logs table exists (catch-up for dual-0101 conflict)
--
-- Background:
--   Two migrations were inadvertently numbered 0101:
--     0101_add_renter_phone.sql      — adds bookings.renter_phone
--     0101_sms_delivery_logs.sql     — creates the sms_delivery_logs table
--   Depending on how the migrations were applied, sms_delivery_logs may not
--   have been created in production.  0102_sms_delivery_logs_provider_id.sql
--   would also have silently failed in that case.
--
--   This migration is fully idempotent and ensures:
--     1. The sms_delivery_logs table exists with all required columns.
--     2. The provider_id column (from 0102) is present.
--     3. All indexes are created.
--
--   Safe to run even if 0101 / 0102 were already applied — every statement
--   uses CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS sms_delivery_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref   TEXT,
  vehicle_id    TEXT,
  renter_phone  TEXT,
  message_type  TEXT,
  message_body  TEXT,
  status        TEXT        NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- provider_id was added in 0102; ensure it exists here as well
ALTER TABLE sms_delivery_logs ADD COLUMN IF NOT EXISTS provider_id TEXT;

CREATE INDEX IF NOT EXISTS sms_delivery_logs_created_at_idx  ON sms_delivery_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_booking_ref_idx ON sms_delivery_logs (booking_ref);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_status_idx      ON sms_delivery_logs (status);

COMMENT ON TABLE  sms_delivery_logs IS 'Append-only SMS delivery visibility log. Every send attempt is recorded with status (sent/failed/skipped). Does not affect deduplication — see sms_logs for dedup.';
COMMENT ON COLUMN sms_delivery_logs.status      IS 'sent = TextMagic accepted the message; failed = TextMagic threw an error; skipped = no phone number available.';
COMMENT ON COLUMN sms_delivery_logs.provider_id IS 'SMS provider message/session ID (e.g. TextMagic session id). Null for failed/skipped rows.';
