-- Migration 0063: Add actual_return_time to bookings
--
-- Records the real-world timestamp when a renter physically returns the vehicle.
-- Populated automatically when admin clicks "Returned" (status → completed_rental).
-- Used to compute early-return trimming of blocked_dates and next-available display.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'bookings'
      AND column_name  = 'actual_return_time'
  ) THEN
    ALTER TABLE public.bookings
      ADD COLUMN actual_return_time timestamptz;
    COMMENT ON COLUMN public.bookings.actual_return_time
      IS 'Timestamp when the vehicle was physically returned. Set by the admin "Returned" action.';
  END IF;
END $$;
