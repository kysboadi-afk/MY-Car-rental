-- Migration 0067: Fix Anthony Johnson pickup/return time for booking bk-3bcf479ac6ec
--
-- Background: Anthony selected 4:00 PM as his pickup time on the booking form,
-- but the booking was stored with 08:00:00 (8am) due to the auto-selected
-- default time slot not being overridden correctly.  This corrects both
-- pickup_time and return_time to 16:00:00 (4:00 PM LA time) and also updates
-- the revenue_records row for the same booking so the times are consistent.
--
-- pickup date:  2026-04-23
-- return date:  2026-04-30
-- vehicle:      camry (Camry 2012)
-- booking_ref:  bk-3bcf479ac6ec

UPDATE public.bookings
SET
  pickup_time = '16:00:00',
  return_time = '16:00:00',
  updated_at  = now()
WHERE booking_ref = 'bk-3bcf479ac6ec';

-- Also update the rental revenue_records placeholder row so pickup/return times
-- are consistent there (the reservation_deposit row does not carry time fields).
UPDATE public.revenue_records
SET
  pickup_date = '2026-04-23',
  return_date = '2026-04-30'
WHERE booking_id = 'bk-3bcf479ac6ec'
  AND type = 'rental';
