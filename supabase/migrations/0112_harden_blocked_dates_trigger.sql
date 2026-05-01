-- Migration 0112: Harden on_booking_create trigger — explicit booking_ref guard
--
-- The previous migration (0111) wrapped the blocked_dates INSERT in an
-- EXCEPTION handler so any constraint failure is demoted to a WARNING and the
-- booking transaction is never aborted.  This migration adds an explicit guard
-- *before* the INSERT that fires when NEW.booking_ref IS NULL, producing a
-- clear, actionable error message instead of a cryptic NOT-NULL constraint
-- message from Postgres.
--
-- Because the guard is placed INSIDE the existing BEGIN ... EXCEPTION block,
-- the RAISE EXCEPTION is caught by EXCEPTION WHEN OTHERS and re-emitted as a
-- RAISE WARNING — so the booking INSERT still succeeds even in this degenerate
-- case, which should never occur given the server-side pre-write in
-- create-payment-intent.js.

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Block the vehicle dates for this booking period.
  -- Always pass booking_ref so the row satisfies any NOT NULL constraint.
  -- The inner BEGIN/EXCEPTION block ensures a blocked_dates failure NEVER
  -- rolls back the parent booking INSERT.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    BEGIN
      -- Guard: booking_ref must be present.  RAISE EXCEPTION here so the error
      -- message is clear; it will be caught below and re-emitted as a WARNING.
      IF NEW.booking_ref IS NULL THEN
        RAISE EXCEPTION
          'on_booking_create: booking_ref is NULL for booking id=% — blocked_dates insert skipped',
          NEW.id;
      END IF;

      INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason, booking_ref)
      VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking', NEW.booking_ref)
      ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'on_booking_create: blocked_dates insert failed for booking_ref=% (non-fatal): %',
        NEW.booking_ref, SQLERRM;
    END;
  END IF;

  -- Auto-create a revenue row when the booking has a price.
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Sync vehicle rental_status based on initial status.
  CASE NEW.status
    WHEN 'approved' THEN UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active'   THEN UPDATE vehicles SET rental_status = 'rented'   WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;
