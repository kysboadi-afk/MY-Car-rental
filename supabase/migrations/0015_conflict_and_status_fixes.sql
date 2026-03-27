-- =============================================================================
-- SLY RIDES — Migration 0015: Conflict & Status Fixes
-- =============================================================================
--
-- What this migration does:
--   1. Adds 'reserved' to vehicles.rental_status check constraint
--      (approved bookings mark the vehicle as reserved while awaiting pickup)
--   2. Replaces check_booking_conflicts trigger with a datetime-aware version
--      that combines pickup_date + pickup_time and return_date + return_time
--      so that back-to-back bookings on the same day are allowed
--   3. Updates on_booking_status_change trigger to implement the full flow:
--        pending  → vehicle available
--        approved → vehicle reserved
--        active   → vehicle rented
--        completed → vehicle available
--        cancelled → vehicle available (was: active only)
--   4. Updates on_booking_create trigger to set vehicle reserved when a new
--      booking is inserted with status = 'approved'
--
-- Safe to re-run: all statements use CREATE OR REPLACE / DROP IF EXISTS guards.
-- =============================================================================

-- ── 1. Add 'reserved' to rental_status check constraint ──────────────────────
-- We must drop the old constraint and recreate it with the new allowed values.
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_rental_status_check;

ALTER TABLE vehicles ADD CONSTRAINT vehicles_rental_status_check
  CHECK (rental_status IN ('available', 'reserved', 'rented', 'maintenance'));

-- ── 2. Datetime-aware conflict check trigger ──────────────────────────────────
-- Helper: combine a date + time column pair into a timestamp.
-- When time is NULL and is_end = false: uses midnight (start of day).
-- When time is NULL and is_end = true:  uses midnight of the NEXT day (exclusive
--   end boundary) so that the full last day is included.  This is consistent with
--   the JavaScript hasDateTimeOverlap helper in api/_availability.js.
CREATE OR REPLACE FUNCTION booking_datetime(d date, t time, is_end boolean DEFAULT false)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t IS NOT NULL THEN (d + t)::timestamptz
    WHEN is_end        THEN (d + interval '1 day')::timestamptz
    ELSE                    d::timestamptz          -- midnight
  END
$$;

-- Recreate the conflict-check trigger with datetime precision
CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conflict_id uuid;
  v_blocked_vid text;
  new_start     timestamptz;
  new_end       timestamptz;
BEGIN
  -- Cancelled bookings never conflict
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Require at least pickup_date for conflict checks
  IF NEW.pickup_date IS NULL THEN
    RETURN NEW;
  END IF;

  new_start := booking_datetime(NEW.pickup_date,  NEW.pickup_time,  false);
  new_end   := booking_datetime(NEW.return_date,  NEW.return_time,  true);

  -- Check for overlapping non-cancelled bookings on the same vehicle.
  -- Two bookings overlap when: existing.start < new.end AND existing.end > new.start
  SELECT b.id INTO v_conflict_id
  FROM   bookings b
  WHERE  b.vehicle_id = NEW.vehicle_id
    AND  b.status NOT IN ('cancelled')
    AND  b.id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND  booking_datetime(b.pickup_date, b.pickup_time, false) < new_end
    AND  booking_datetime(b.return_date, b.return_time, true)  > new_start
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Booking conflict: vehicle % is already booked overlapping % to % (conflicts with booking %)',
      NEW.vehicle_id,
      new_start AT TIME ZONE 'UTC',
      new_end   AT TIME ZONE 'UTC',
      v_conflict_id;
  END IF;

  -- Check blocked_dates conflicts (maintenance / manual blocks only — not 'booking'
  -- rows, which are managed by the bookings table itself).
  SELECT bd.vehicle_id INTO v_blocked_vid
  FROM   blocked_dates bd
  WHERE  bd.vehicle_id = NEW.vehicle_id
    AND  bd.reason    != 'booking'
    AND  bd.start_date <= COALESCE(NEW.return_date, NEW.pickup_date)
    AND  bd.end_date   >= NEW.pickup_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Date conflict: vehicle % has blocked dates overlapping with % to %',
      NEW.vehicle_id, NEW.pickup_date, COALESCE(NEW.return_date, NEW.pickup_date);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_check_conflicts ON bookings;
CREATE TRIGGER bookings_check_conflicts
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION check_booking_conflicts();

-- ── 3. Updated on_booking_create trigger ─────────────────────────────────────
-- Status → vehicle rental_status on INSERT:
--   approved → reserved   (vehicle held, awaiting pickup)
--   active   → rented     (vehicle on the road)
--   (other statuses leave rental_status unchanged on insert)
CREATE OR REPLACE FUNCTION on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Auto-create a blocked_dates entry for this booking period
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
    VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking')
    ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
  END IF;

  -- Auto-create a revenue record when the booking has a price
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Sync vehicle rental_status based on incoming booking status
  CASE NEW.status
    WHEN 'approved' THEN
      UPDATE vehicles SET rental_status = 'reserved'
      WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active' THEN
      UPDATE vehicles SET rental_status = 'rented'
      WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_insert ON bookings;
CREATE TRIGGER bookings_after_insert
  AFTER INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_create();

-- ── 4. Updated on_booking_status_change trigger ───────────────────────────────
-- Full status flow:
--   pending   → vehicle available  (booking not yet confirmed)
--   approved  → vehicle reserved   (booking confirmed; awaiting pickup)
--   active    → vehicle rented     (vehicle on the road)
--   completed → vehicle available  (rental finished)
--   cancelled → vehicle available  (booking cancelled; restore prior state)
CREATE OR REPLACE FUNCTION on_booking_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  CASE NEW.status
    WHEN 'pending' THEN
      -- Un-confirming a booking restores the vehicle to available
      UPDATE vehicles SET rental_status = 'available'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'approved' THEN
      -- Booking confirmed — vehicle is now reserved for this booking
      UPDATE vehicles SET rental_status = 'reserved'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'active' THEN
      -- Vehicle has been picked up
      UPDATE vehicles SET rental_status = 'rented'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'completed' THEN
      -- Rental finished — make vehicle available again
      UPDATE vehicles SET rental_status = 'available'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'cancelled' THEN
      -- Remove the booking-created blocked_dates entry
      DELETE FROM blocked_dates
      WHERE  vehicle_id = NEW.vehicle_id
        AND  start_date = NEW.pickup_date
        AND  end_date   = NEW.return_date
        AND  reason     = 'booking';

      -- Remove revenue record only if no payment was received
      IF NEW.deposit_paid = 0 THEN
        DELETE FROM revenue WHERE booking_id = NEW.id;
      END IF;

      -- Restore vehicle to available regardless of prior status
      UPDATE vehicles SET rental_status = 'available'
      WHERE vehicle_id = NEW.vehicle_id;

    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_status_change ON bookings;
CREATE TRIGGER bookings_after_status_change
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_change();

-- =============================================================================
-- DONE
-- rental_status now includes 'reserved'.
-- check_booking_conflicts uses datetime precision.
-- on_booking_status_change implements the full pending→approved→active→completed
-- flow with vehicle status sync.
-- =============================================================================
