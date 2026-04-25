-- Migration 0072: SMS logs table for extension-aware deduplication
--
-- Purpose:
-- Creates a sms_logs table that records every outbound SMS keyed by
-- (booking_id, template_key, return_date_at_send).  Using return_date_at_send
-- as part of the composite key means that when a rental is extended the old
-- "return-time" triggers (late_warning_30min, late_at_return, etc.) are no
-- longer suppressed for the new return date, preventing missed notifications.
--
-- For SMS not tied to a return date (pickup reminders, payment reminders, etc.)
-- return_date_at_send is stored as '1970-01-01' (a sentinel "not applicable"
-- value) which is excluded from the NULL quirks of unique constraints.

CREATE TABLE IF NOT EXISTS sms_logs (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           text          NOT NULL,   -- booking_ref from bookings table (bk-...)
  template_key         text          NOT NULL,   -- e.g. 'late_warning_30min', 'late_at_return'
  return_date_at_send  date          NOT NULL DEFAULT '1970-01-01', -- sentinel for non-return-time messages
  sent_at              timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT sms_logs_dedup UNIQUE (booking_id, template_key, return_date_at_send)
);

CREATE INDEX IF NOT EXISTS sms_logs_booking_id_idx    ON sms_logs (booking_id);
CREATE INDEX IF NOT EXISTS sms_logs_sent_at_idx       ON sms_logs (sent_at DESC);
CREATE INDEX IF NOT EXISTS sms_logs_template_key_idx  ON sms_logs (template_key);

COMMENT ON TABLE  sms_logs IS 'Outbound SMS audit log; (booking_id, template_key, return_date_at_send) is unique to prevent duplicate sends and handle rental extensions correctly.';
COMMENT ON COLUMN sms_logs.return_date_at_send IS 'The booking return_date in effect when the SMS was sent. 1970-01-01 = not applicable (non-return-time messages). Changing return_date via extension allows return-time triggers to fire again for the new date.';
