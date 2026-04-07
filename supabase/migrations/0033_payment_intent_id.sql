-- =============================================================================
-- SLY RIDES — Migration 0033: Add payment_intent_id to bookings table
-- =============================================================================
--
-- What this migration does:
--   Adds a payment_intent_id text column to the bookings table so that every
--   booking created via the public booking flow (Stripe) or manually via the
--   admin panel can store the Stripe PaymentIntent ID.  This enables:
--   1. The admin booking list (v2-bookings.js) to surface the Stripe ID
--      directly from Supabase (previously caused a SELECT error and silent
--      fallback to bookings.json).
--   2. autoUpsertBooking in _booking-automation.js to sync the payment
--      intent ID into Supabase alongside all other booking fields.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS guard.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_intent_id text;

CREATE INDEX IF NOT EXISTS bookings_payment_intent_id_idx
  ON bookings (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
