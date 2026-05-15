-- Migration 0154: confirmed inventory lifecycle for blocked_dates
--
-- Goal:
--   Keep pre-payment bookings in the database for webhook linkage / retry cleanup
--   while ensuring public inventory is blocked only after a confirmed payment.
--
-- Change:
--   Tighten on_booking_create so blocked_dates rows are created only for
--   confirmed reservation / occupancy statuses. Pending checkout rows must not
--   create public inventory blocks.

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_end_date DATE;
  v_end_time TIME;
BEGIN
  -- Only confirmed reservation / occupancy states may create blocked_dates rows.
  -- This keeps pending checkout attempts from affecting public availability.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status IN ('reserved', 'booked_paid', 'approved', 'active', 'active_rental', 'overdue') THEN
    BEGIN
      IF NEW.booking_ref IS NULL THEN
        RAISE EXCEPTION
          'on_booking_create: booking_ref is NULL for booking id=% — blocked_dates insert skipped',
          NEW.id;
      END IF;

      IF NEW.return_time IS NOT NULL THEN
        v_end_date := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::DATE;
        v_end_time := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::TIME;
      ELSE
        v_end_date := NEW.return_date;
        v_end_time := NULL;
      END IF;

      UPDATE blocked_dates
      SET end_date = v_end_date,
          end_time = v_end_time
      WHERE vehicle_id  = NEW.vehicle_id
        AND booking_ref = NEW.booking_ref
        AND reason      = 'booking'
        AND (end_time IS DISTINCT FROM v_end_time OR end_date IS DISTINCT FROM v_end_date);

      IF NOT FOUND THEN
        INSERT INTO blocked_dates (vehicle_id, start_date, end_date, end_time, reason, booking_ref)
        VALUES (NEW.vehicle_id, NEW.pickup_date, v_end_date, v_end_time, 'booking', NEW.booking_ref)
        ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'on_booking_create: blocked_dates insert failed for booking_ref=% (non-fatal): %',
        NEW.booking_ref, SQLERRM;
    END;
  END IF;

  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  CASE NEW.status
    WHEN 'approved' THEN UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active'   THEN UPDATE vehicles SET rental_status = 'rented'   WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;
