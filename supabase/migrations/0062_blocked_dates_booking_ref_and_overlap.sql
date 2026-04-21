-- Migration 0062: blocked_dates — booking_ref linkage + no-overlap constraint + TTL cleanup
--
-- 1. Add optional booking_ref column that links a blocked range back to the booking that created it.
-- 2. Add an overlap-prevention trigger so only non-overlapping ranges can coexist per vehicle.
-- 3. Add an index to support fast TTL queries (cleanup of past ranges).

-- ── 1. Add booking_ref column (nullable, FK to bookings.booking_ref) ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'blocked_dates'
      AND column_name  = 'booking_ref'
  ) THEN
    ALTER TABLE public.blocked_dates
      ADD COLUMN booking_ref text REFERENCES public.bookings(booking_ref) ON DELETE SET NULL;
    COMMENT ON COLUMN public.blocked_dates.booking_ref
      IS 'Optional link to the booking that created this block. NULL for manual/maintenance blocks.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS blocked_dates_booking_ref_idx
  ON public.blocked_dates (booking_ref)
  WHERE booking_ref IS NOT NULL;

-- ── 2. Overlap-prevention trigger ─────────────────────────────────────────────
-- Raises an exception when a new row would overlap an existing range for the
-- same vehicle.  Two ranges [a,b] and [c,d] overlap when a <= d AND c <= b.

CREATE OR REPLACE FUNCTION public.check_blocked_dates_overlap()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.blocked_dates
    WHERE vehicle_id  = NEW.vehicle_id
      AND start_date <= NEW.end_date
      AND end_date   >= NEW.start_date
      AND id         != COALESCE(NEW.id, -1)
  ) THEN
    RAISE EXCEPTION
      'blocked_dates overlap: vehicle % already has a blocked range overlapping % – %',
      NEW.vehicle_id, NEW.start_date, NEW.end_date
    USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Drop existing trigger first so re-running the migration is idempotent
DROP TRIGGER IF EXISTS trg_blocked_dates_no_overlap ON public.blocked_dates;

CREATE TRIGGER trg_blocked_dates_no_overlap
  BEFORE INSERT OR UPDATE ON public.blocked_dates
  FOR EACH ROW EXECUTE FUNCTION public.check_blocked_dates_overlap();

-- ── 3. Index for TTL / expired-range cleanup queries ─────────────────────────
CREATE INDEX IF NOT EXISTS blocked_dates_end_date_idx
  ON public.blocked_dates (end_date);
