-- migration 0101: add renter_phone as the canonical SMS phone column for bookings
--
-- Background: the existing customer_phone column was originally used for all
-- phone writes but its name conflates CRM customer data with booking-level
-- contact info.  renter_phone is the single source of truth for SMS delivery;
-- it is always the phone of the person who made the specific booking.
--
-- customer_phone is kept for backward compatibility with existing queries,
-- admin views, and revenue_records joins.  New writes should target
-- renter_phone; customer_phone will be retired in a future migration.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS renter_phone text;

-- Backfill from customer_phone for all existing rows.
UPDATE bookings
SET    renter_phone = customer_phone
WHERE  customer_phone IS NOT NULL
  AND  renter_phone  IS NULL;

-- Index so scheduled-reminders can efficiently find bookings with missing
-- renter_phone that need a Stripe fallback lookup.
CREATE INDEX IF NOT EXISTS idx_bookings_renter_phone_null
  ON bookings (status)
  WHERE renter_phone IS NULL;
