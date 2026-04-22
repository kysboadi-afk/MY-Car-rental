-- Migration 0064: Standardize legacy active booking status
--
-- Purpose:
-- Normalize legacy booking rows that still use status='active' so all active
-- rentals use status='active_rental' in application-facing flows.
--
-- Note:
-- Some legacy environments may still enforce older status check constraints
-- that do not yet allow 'active_rental'. In that case this migration logs a
-- notice and skips the rewrite instead of failing.

DO $$
BEGIN
  BEGIN
    UPDATE bookings
    SET status = 'active_rental'
    WHERE status = 'active';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Skipping active→active_rental rewrite because bookings.status constraint rejects active_rental.';
  END;
END $$;
