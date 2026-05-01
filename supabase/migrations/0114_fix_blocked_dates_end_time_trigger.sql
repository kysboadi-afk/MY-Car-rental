-- Migration 0114: Fix on_booking_create trigger to include end_time;
--                 heal existing blocked_dates rows missing end_time.
--
-- Root cause of "return time not showing on cars page":
--   The on_booking_create DB trigger (migration 0112) inserts a blocked_dates
--   row without the end_time column.  Migration 0094 added end_time and
--   backfilled rows that existed at that time, but every booking created after
--   0094 gets a trigger-created row with end_time = NULL.  The app-side
--   autoCreateBlockedDate used ignoreDuplicates:true, so it never patched those
--   rows.  fleet-status.js only sets available_at (and includes the time in
--   "Next Available") when end_time is non-null.
--
-- Fix:
--   1. Update on_booking_create to compute buffered end_date + end_time from
--      the booking's return_date and return_time (buffer = 2 hours, matching
--      BOOKING_BUFFER_HOURS in _booking-automation.js).
--      Uses UPDATE-by-booking_ref then INSERT (rather than INSERT + ON CONFLICT
--      DO UPDATE on the composite key) so the logic is correct even when the
--      2-hour buffer shifts end_date across midnight.
--   2. Backfill all existing blocked_dates rows that still have end_time = NULL
--      using the same 2-hour buffered logic as migration 0094.

-- ── 1. Replace on_booking_create trigger ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_end_date DATE;
  v_end_time TIME;
BEGIN
  -- Block the vehicle dates for this booking period.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    BEGIN
      -- Guard: booking_ref must be present.
      IF NEW.booking_ref IS NULL THEN
        RAISE EXCEPTION
          'on_booking_create: booking_ref is NULL for booking id=% — blocked_dates insert skipped',
          NEW.id;
      END IF;

      -- Compute buffered end_date + end_time (return_time + 2-hour buffer).
      -- The 2-hour buffer gives the owner preparation time between rentals and
      -- matches BOOKING_BUFFER_HOURS in api/_booking-automation.js.
      IF NEW.return_time IS NOT NULL THEN
        v_end_date := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::DATE;
        v_end_time := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::TIME;
      ELSE
        v_end_date := NEW.return_date;
        v_end_time := NULL;
      END IF;

      -- First try to patch an existing row by booking_ref (idempotent self-heal).
      -- This avoids the end_date mismatch that would occur with the composite
      -- (vehicle_id, start_date, end_date, reason) conflict key when the 2-hour
      -- buffer shifts end_date across midnight.
      UPDATE blocked_dates
      SET end_date = v_end_date,
          end_time = v_end_time
      WHERE vehicle_id  = NEW.vehicle_id
        AND booking_ref = NEW.booking_ref
        AND reason      = 'booking'
        -- OR: update if either field differs — both are always written together
        AND (end_time IS DISTINCT FROM v_end_time OR end_date IS DISTINCT FROM v_end_date);

      -- If no existing row was updated, insert a new one.
      -- This is the normal path: the trigger fires on the first INSERT of a
      -- new booking, before any blocked_dates row exists for it.
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

-- ── 2. Backfill existing blocked_dates rows with null end_time ─────────────
-- For booking-type rows: compute buffered end_date + end_time from the linked
-- booking's return_time.  Update both end_date (handles midnight-crossing
-- buffer) and end_time.  Matches the logic in the updated trigger above.
UPDATE public.blocked_dates bd
SET
  end_date = (
    b.return_date::TIMESTAMP + b.return_time::INTERVAL + INTERVAL '2 hours'
  )::DATE,
  end_time = (
    b.return_date::TIMESTAMP + b.return_time::INTERVAL + INTERVAL '2 hours'
  )::TIME
FROM public.bookings b
WHERE bd.booking_ref = b.booking_ref
  AND bd.reason      = 'booking'
  AND bd.end_time    IS NULL
  AND b.return_time  IS NOT NULL;

-- Any remaining booking rows without a matching bookings.return_time: apply
-- the safe default (DEFAULT_RETURN_TIME "10:00" + 2-hour buffer = 12:00).
UPDATE public.blocked_dates
SET end_time = '12:00:00'::TIME
WHERE reason   = 'booking'
  AND end_time IS NULL;
