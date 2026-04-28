-- Migration 0101: SMS delivery logs table for full SMS visibility
--
-- Purpose:
-- Creates a sms_delivery_logs table that records EVERY outbound SMS attempt
-- with a status of 'sent', 'failed', or 'skipped'.  Unlike the existing
-- sms_logs dedup table, this table is append-only and is used exclusively
-- for visibility and debugging — it does NOT affect deduplication logic.
--
-- Columns:
--   booking_ref   – booking_ref (bk-...) of the affected booking
--   vehicle_id    – vehicle being rented
--   renter_phone  – E.164 recipient number (null if skipped/no phone)
--   message_type  – template key, e.g. 'late_warning_30min'
--   message_body  – rendered SMS text sent (or attempted)
--   status        – 'sent' | 'failed' | 'skipped'
--   error         – error message when status is 'failed' or 'skipped'
--   created_at    – wall-clock time of the attempt

CREATE TABLE IF NOT EXISTS sms_delivery_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref   TEXT,
  vehicle_id    TEXT,
  renter_phone  TEXT,
  message_type  TEXT,
  message_body  TEXT,
  status        TEXT        NOT NULL,   -- sent | failed | skipped
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sms_delivery_logs_created_at_idx  ON sms_delivery_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_booking_ref_idx ON sms_delivery_logs (booking_ref);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_status_idx      ON sms_delivery_logs (status);

COMMENT ON TABLE  sms_delivery_logs IS 'Append-only SMS delivery visibility log. Every send attempt is recorded with status (sent/failed/skipped). Does not affect deduplication — see sms_logs for dedup.';
COMMENT ON COLUMN sms_delivery_logs.status IS 'sent = TextMagic accepted the message; failed = TextMagic threw an error; skipped = no phone number available.';
