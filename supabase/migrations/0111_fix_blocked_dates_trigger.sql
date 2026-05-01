-- Migration 0111: Fix on_booking_create trigger — pass booking_ref to blocked_dates
--                 and make the insert non-blocking.
--
-- Root cause:
--   The on_booking_create trigger fires AFTER INSERT on bookings and inserts into
--   blocked_dates WITHOUT booking_ref.  If booking_ref has a NOT NULL constraint the
--   trigger raises an exception and PostgreSQL rolls back the entire booking INSERT —
--   no booking row is saved, no revenue record is created.
--
-- Fix:
--   1. Pass NEW.booking_ref to the blocked_dates INSERT so the row is fully populated.
--   2. Wrap the blocked_dates INSERT in an EXCEPTION handler so any future constraint
--      failure (NOT NULL, overlap, FK) is emitted as a WARNING and never aborts the
--      parent booking transaction.  Revenue and booking persistence are unaffected.

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Block the vehicle dates for this booking period.
  -- Always pass booking_ref so the row satisfies any NOT NULL constraint.
  -- Wrapped in EXCEPTION so a blocked_dates failure NEVER rolls back the booking INSERT.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    BEGIN
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
