-- Migration 0100: return_booking_atomic RPC
--
-- Provides a single-transaction "return booking" operation so that
-- status promotion, timestamp stamping, and blocked_dates cleanup are
-- always consistent — even if the calling Vercel function retries.
--
-- What the function does (all in one transaction):
--   1. Locks the bookings row by booking_ref (FOR UPDATE) to prevent
--      concurrent double-returns.
--   2. Validates that the booking exists and is in an active state
--      ('active_rental', 'overdue', or the legacy alias 'active').
--      Raises an exception with a clear message on any other state.
--   3. Updates the booking:
--        status            → 'completed_rental'
--        completed_at      → now()
--        actual_return_time → now()   (ISO timestamp of actual wall-clock return)
--        updated_at        → now()
--   4. Deletes all blocked_dates rows whose booking_ref matches, so
--      fleet-status.js immediately reports the vehicle as available
--      without waiting for the nightly cleanup job.
--   5. Returns a JSONB payload with the booking details for the caller
--      to confirm and log.
--
-- Idempotency: if called a second time for an already-completed booking
-- the validation guard raises EXCEPTION 'already_completed', which the
-- endpoint translates to HTTP 409 rather than 500, so retries are safe.
--
-- Safe to re-run: CREATE OR REPLACE is idempotent.

CREATE OR REPLACE FUNCTION public.return_booking_atomic(
  booking_ref_input text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking bookings%ROWTYPE;
BEGIN
  IF booking_ref_input IS NULL OR btrim(booking_ref_input) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  -- Lock the row to prevent concurrent double-returns.
  SELECT *
  INTO   v_booking
  FROM   public.bookings
  WHERE  booking_ref = booking_ref_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found: %', booking_ref_input;
  END IF;

  -- Guard: only allow the transition from an active state.
  IF v_booking.status IN ('completed_rental', 'completed') THEN
    RAISE EXCEPTION 'already_completed';
  END IF;

  IF v_booking.status NOT IN ('active_rental', 'overdue', 'active') THEN
    RAISE EXCEPTION
      'Cannot return booking with status "%": must be active_rental, overdue, or active',
      v_booking.status;
  END IF;

  -- Mark the booking as returned.
  UPDATE public.bookings
  SET
    status             = 'completed_rental',
    completed_at       = now(),
    actual_return_time = now(),
    updated_at         = now()
  WHERE booking_ref = booking_ref_input;

  -- Release availability: delete the blocked_dates row(s) for this booking
  -- so fleet-status.js immediately shows the vehicle as available.
  DELETE FROM public.blocked_dates
  WHERE booking_ref = booking_ref_input;

  RETURN jsonb_build_object(
    'booking_ref',       v_booking.booking_ref,
    'vehicle_id',        v_booking.vehicle_id,
    'previous_status',   v_booking.status,
    'status',            'completed_rental',
    'completed_at',      now()
  );
END;
$$;
