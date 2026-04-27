-- Migration 0094: add end_time to blocked_dates for accurate availability timing
--
-- Problem: blocked_dates only stored end_date (DATE), causing availability to
-- be blocked for the entire day regardless of the actual return time.  A
-- booking that returns at 3 PM would keep the vehicle unavailable until
-- midnight, preventing same-day back-to-back rentals from being offered.
--
-- Fix: add end_time (TIME) to store the return time + preparation buffer so
-- fleet-status can compute an exact "available at" timestamp.
--
--   end_date + end_time = return_datetime + BOOKING_BUFFER_HOURS (2 h)
--
-- Rows written before this migration (no end_time) are backfilled with the
-- canonical DEFAULT_RETURN_TIME so existing blocks stay conservative.
-- Manual and maintenance blocks receive NULL (date-only behaviour is correct
-- for those — no specific return time to reflect).

-- 1. Add the column.
ALTER TABLE public.blocked_dates
  ADD COLUMN IF NOT EXISTS end_time TIME NULL;

-- 2. Backfill booking rows that have a matching bookings.return_time.
--    Uses the stored return_time + 2-hour buffer where available;
--    falls back to DEFAULT_RETURN_TIME (10:00) + buffer (→ 12:00).
UPDATE public.blocked_dates bd
SET end_time = CASE
  WHEN b.return_time IS NOT NULL
    THEN ((b.return_time::interval + interval '2 hours')::time)
  ELSE '12:00:00'::time  -- DEFAULT_RETURN_TIME ("10:00") + 2 h
END
FROM public.bookings b
WHERE bd.booking_ref = b.booking_ref
  AND bd.reason = 'booking'
  AND bd.end_time IS NULL;

-- 3. Any remaining booking rows without a bookings match get the safe default.
UPDATE public.blocked_dates
SET end_time = '12:00:00'::time
WHERE reason = 'booking'
  AND end_time IS NULL;

-- Manual / maintenance rows are intentionally left with end_time = NULL:
-- they have no return time to reflect, so date-only display is correct.
