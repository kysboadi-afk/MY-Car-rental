-- =============================================================================
-- SLY RIDES — Migration 0035: Add Stripe customer / payment-method columns
-- =============================================================================
--
-- What this migration does:
--   Adds stripe_customer_id and stripe_payment_method_id to the bookings table
--   so that every Stripe booking captures the saved card details needed for
--   future off-session charges (e.g., damages, late fees).
--
--   These values are populated by:
--     • create-payment-intent.js  — creates/finds the Stripe Customer and embeds
--                                   stripe_customer_id in the PaymentIntent metadata.
--     • stripe-webhook.js         — extracts paymentIntent.customer and
--                                   paymentIntent.payment_method on
--                                   payment_intent.succeeded and writes them into
--                                   the booking record.
--     • _booking-automation.js    — syncs both fields via autoUpsertBooking().
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS guard.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS stripe_customer_id       text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text;

CREATE INDEX IF NOT EXISTS bookings_stripe_customer_id_idx
  ON bookings (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
