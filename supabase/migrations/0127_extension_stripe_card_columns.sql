-- Migration 0127: store the Stripe card used for rental extensions separately
--
-- A renter may pay for their extension with a different card than the one used
-- for the original booking.  These two columns capture that card so it can be
-- used as a fallback for off-session charges (late fees, damages, etc.) when
-- the original booking card is absent or declined.
--
-- COALESCE semantics are applied in JS (autoUpsertBooking) and in SQL via the
-- upsert_booking_revenue_atomic RPC — these columns are never overwritten with
-- NULL/empty once a value has been written.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS extension_stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS extension_stripe_payment_method_id TEXT;

COMMENT ON COLUMN bookings.extension_stripe_customer_id IS
  'Stripe Customer ID from the most-recent rental-extension payment. Used as a card-charge fallback when stripe_customer_id is absent.';
COMMENT ON COLUMN bookings.extension_stripe_payment_method_id IS
  'Stripe PaymentMethod ID from the most-recent rental-extension payment. Used as a card-charge fallback when stripe_payment_method_id is absent.';
