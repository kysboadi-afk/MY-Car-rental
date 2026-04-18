-- Migration 0054: pending_booking_docs table
--
-- Purpose: store the renter's signature, ID photo, and insurance document
-- server-side BEFORE the Stripe payment is confirmed so the webhook can
-- send the owner a full email (signed agreement PDF + ID + insurance)
-- even when the customer's browser fails to call send-reservation-email.js.
--
-- Rows are cleaned up automatically after 7 days via a lightweight nightly job,
-- or manually after email_sent is confirmed true.
--
-- Safe to re-run: all statements use IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS pending_booking_docs (
  booking_id           text        PRIMARY KEY,
  signature            text,
  id_base64            text,
  id_filename          text,
  id_mimetype          text,
  insurance_base64     text,
  insurance_filename   text,
  insurance_mimetype   text,
  insurance_coverage_choice text,
  email_sent           boolean     NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_booking_docs_created_at_idx
  ON pending_booking_docs (created_at);

-- Service-role only; no public access.
ALTER TABLE pending_booking_docs ENABLE ROW LEVEL SECURITY;
