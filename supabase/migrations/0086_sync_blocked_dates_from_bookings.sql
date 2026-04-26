-- Migration 0086: sync blocked_dates.end_date to match bookings.return_date for active rentals
--
-- Problem:
--   When a rental extension is paid, stripe-webhook.js calls
--   extendBlockedDateForBooking() to advance blocked_dates.end_date.
--   For historical or edge-case extensions this call may have failed silently,
--   leaving blocked_dates.end_date pointing to the pre-extension return date.
--
--   fleet-status.js derives "Next Available" exclusively from
--   MAX(blocked_dates.end_date) per vehicle, so a stale end_date causes the
--   public car listing to show an outdated availability date even after the
--   renter has paid for an extension.
--
-- Fix:
--   For every 'booking' row in blocked_dates that is linked to an active
--   booking whose current return_date is LATER than the blocked end_date,
--   advance end_date to match bookings.return_date.
--
--   Only advances end_date (never shrinks it) and only for active/overdue
--   bookings, so completed or cancelled rentals are untouched.
--
-- Safe to re-run: the WHERE clause only matches rows that need updating
--   (return_date > end_date), so already-correct rows are skipped.
--
-- Note on the overlap trigger:
--   trg_blocked_dates_no_overlap fires on UPDATE but excludes the row being
--   updated (id != COALESCE(NEW.id, -1)), so extending an existing block
--   never conflicts with itself.

UPDATE public.blocked_dates bd
SET    end_date = b.return_date::date
FROM   public.bookings b
WHERE  bd.booking_ref = b.booking_ref
  AND  bd.vehicle_id  = b.vehicle_id
  AND  bd.reason      = 'booking'
  AND  b.status       IN ('active', 'active_rental', 'overdue')
  AND  b.return_date  IS NOT NULL
  AND  b.return_date::date > bd.end_date;
