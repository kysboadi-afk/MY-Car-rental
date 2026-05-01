-- Migration 0115: add balance_due to bookings
-- balance_due stores the outstanding unpaid amount when a Stripe payment fails.
-- A non-zero balance_due blocks the customer from making new bookings until cleared.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due NUMERIC DEFAULT 0;

COMMENT ON COLUMN bookings.balance_due IS
  'Outstanding unpaid amount (USD) after a failed Stripe payment. '
  'A non-zero value blocks the customer from creating new bookings. '
  'Cleared to 0 when the balance is successfully paid.';
