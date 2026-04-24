-- Migration 0073: Extension tracking columns on bookings
--
-- Purpose:
-- Adds `last_extension_at` and `extension_count` columns to the bookings table
-- so extension history is durably recorded in Supabase (not just in bookings.json).
--
-- These values are written by stripe-webhook.js when a rental_extension payment
-- succeeds.  `last_extension_at` is used by the SMS engine to verify the booking
-- has been extended and to present up-to-date return dates.
--
-- `extension_count` mirrors the extensionCount field already tracked in
-- bookings.json; the default of 0 is correct for all historical rows.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_extension_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extension_count   integer NOT NULL DEFAULT 0;

-- Partial index for finding recently extended bookings efficiently.
CREATE INDEX IF NOT EXISTS bookings_last_extension_at_idx
  ON bookings (last_extension_at)
  WHERE last_extension_at IS NOT NULL;

COMMENT ON COLUMN bookings.last_extension_at IS 'Timestamp of the most recent paid extension. Updated by stripe-webhook on rental_extension payment success.';
COMMENT ON COLUMN bookings.extension_count   IS 'Total number of paid extensions applied to this booking. Mirrors extensionCount in bookings.json.';
