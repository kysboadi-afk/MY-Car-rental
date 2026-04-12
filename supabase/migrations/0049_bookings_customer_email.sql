-- =============================================================================
-- SLY RIDES — Migration 0049: Add customer_email to bookings table
-- =============================================================================
--
-- What this migration does:
--   Adds a customer_email column to the bookings table so that the renter's
--   email is stored directly on each booking row — without requiring a JOIN
--   to the customers table.
--
--   This field is populated by autoUpsertBooking() in _booking-automation.js
--   from booking.email (sourced from Stripe PaymentIntent metadata or admin
--   input) on both INSERT and UPDATE paths.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS guard.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_email text;

CREATE INDEX IF NOT EXISTS bookings_customer_email_idx
  ON bookings (customer_email)
  WHERE customer_email IS NOT NULL;
