-- Migration 0095: Fix check_booking_conflicts trigger to exclude completed / cancelled statuses
--
-- Problem: The trigger currently uses `status NOT IN ('cancelled')`, which means
-- bookings with status 'completed', 'completed_rental', or 'cancelled_rental' are
-- still treated as active when checking for date overlaps.
--
-- This causes new bookings to be rejected with "Booking conflict" even when the
-- vehicle was freed up by a completed or cancelled rental, specifically when:
--   • A completed rental's return_date equals the new booking's pickup_date AND
--     the return_time is NULL (booking_datetime returns midnight of the next day),
--     making booking_datetime(return) > new_start TRUE and triggering a false conflict.
--
-- Fix: Expand the status exclusion to include 'completed', 'completed_rental',
-- and 'cancelled_rental'.  These statuses mean the vehicle is free; they must
-- not block new bookings.
--
-- Also: Skip the conflict check when the NEW row itself has a terminal status
-- ('completed', 'completed_rental', 'cancelled_rental') to match the existing
-- 'cancelled' fast-path guard.
--
-- Safe to re-run: DROP + CREATE is idempotent for triggers and functions.

CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conflict_id uuid;
  v_blocked_vid text;
  new_start     timestamptz;
  new_end       timestamptz;
BEGIN
  -- Terminal / free-vehicle statuses — no conflict check needed.
  IF NEW.status IN ('cancelled', 'completed', 'completed_rental', 'cancelled_rental') THEN
    RETURN NEW;
  END IF;
  IF NEW.pickup_date IS NULL THEN RETURN NEW; END IF;

  new_start := booking_datetime(NEW.pickup_date, NEW.pickup_time, false);
  new_end   := booking_datetime(NEW.return_date, NEW.return_time, true);

  -- Check for overlapping active bookings on the same vehicle.
  -- Exclude statuses that mean the vehicle is free.
  SELECT b.id INTO v_conflict_id
  FROM   bookings b
  WHERE  b.vehicle_id = NEW.vehicle_id
    AND  b.status NOT IN ('cancelled', 'completed', 'completed_rental', 'cancelled_rental')
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

  -- Check maintenance / manual blocked_dates only (not 'booking' — managed by bookings table)
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
