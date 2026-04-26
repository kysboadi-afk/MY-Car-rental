-- Migration 0087: vehicle_blocking_ranges view
--
-- Purpose:
--   Replace app-code timeline reconstruction from revenue_records with a
--   dedicated DB view that is the single source of truth for per-segment
--   vehicle blocking ranges.
--
--   The view decomposes each booking into:
--     source = 'base'      — the original rental period
--     source = 'extension' — each subsequent paid extension
--
--   Consumers query by vehicle_id:
--     SELECT * FROM public.vehicle_blocking_ranges
--     WHERE vehicle_id = ?
--     ORDER BY start_date ASC
--
-- Why original_return_date is needed:
--   bookings.return_date is advanced on every extension, so after one
--   extension it no longer reflects the base rental's end date.
--   original_return_date is set once on INSERT (via trigger) and never
--   changed by extension processing.  It is the anchor the view uses to
--   reconstruct:
--     - the base segment:       pickup_date → original_return_date
--     - the first extension:    original_return_date → first new_return_date
--     - subsequent extensions:  prev new_return_date → this new_return_date
--
-- Safe to re-run:
--   All DDL uses IF NOT EXISTS / CREATE OR REPLACE.
--   UPDATE backfills are guarded so already-correct rows are skipped.

-- ── 1. Add original_return_date column ───────────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS original_return_date date;

COMMENT ON COLUMN bookings.original_return_date
  IS 'Return date of the base rental before any extension was applied. Set from return_date on INSERT and never changed by extension processing.';

-- ── 2. Backfill original_return_date ─────────────────────────────────────────
--
-- 2a. For bookings that have a matching rental-type revenue_record use its
--     return_date as the authoritative base end (the only durable record of
--     the pre-extension return date for historical rows).

UPDATE bookings b
SET    original_return_date = rr.return_date
FROM   revenue_records rr
WHERE  rr.booking_id        = b.booking_ref
  AND  rr.type              = 'rental'
  AND  rr.sync_excluded     = false
  AND  rr.return_date       IS NOT NULL
  AND  b.original_return_date IS NULL;

-- 2b. For all remaining bookings (no revenue record, or already set):
--     fall back to the current return_date.  For bookings with no extensions
--     this is identical to the original; for extended bookings with no
--     revenue record it is the best available approximation.

UPDATE bookings b
SET    original_return_date = b.return_date
WHERE  b.original_return_date IS NULL
  AND  b.return_date          IS NOT NULL;

-- ── 3. Trigger: auto-set original_return_date on INSERT ──────────────────────
--
-- Ensures every new booking row gets original_return_date = return_date so
-- the view works correctly without any app-code changes to the insert path.

CREATE OR REPLACE FUNCTION public.set_original_return_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.original_return_date IS NULL THEN
    NEW.original_return_date := NEW.return_date;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_set_original_return_date ON bookings;

CREATE TRIGGER bookings_set_original_return_date
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_original_return_date();

-- ── 4. Create vehicle_blocking_ranges view ───────────────────────────────────

CREATE OR REPLACE VIEW public.vehicle_blocking_ranges AS
WITH ext_seq AS (
  -- Reconstruct the sequential date chain for every extension.
  -- For the first extension (LAG = NULL) the start date falls back to the
  -- booking's original_return_date (= base rental end).
  -- For subsequent extensions the start date is the previous extension's
  -- new_return_date, giving a gapless chain.
  SELECT
    be.booking_id,
    b.vehicle_id,
    COALESCE(
      LAG(be.new_return_date) OVER (
        PARTITION BY be.booking_id
        ORDER BY     be.new_return_date ASC, be.created_at ASC
      ),
      b.original_return_date
    )                        AS start_date,
    be.new_return_date       AS end_date
  FROM booking_extensions be
  JOIN bookings b ON b.booking_ref = be.booking_id
)
-- Base rental segment (one row per booking)
SELECT
  b.vehicle_id,
  b.booking_ref,
  b.pickup_date             AS start_date,
  b.original_return_date    AS end_date,
  'base'::text              AS source
FROM bookings b
WHERE b.pickup_date          IS NOT NULL
  AND b.original_return_date IS NOT NULL

UNION ALL

-- Extension segments (one row per paid extension)
SELECT
  es.vehicle_id,
  es.booking_id             AS booking_ref,
  es.start_date,
  es.end_date,
  'extension'::text         AS source
FROM ext_seq es
WHERE es.start_date IS NOT NULL
  AND es.end_date   IS NOT NULL;

COMMENT ON VIEW public.vehicle_blocking_ranges
  IS 'Per-segment vehicle blocking timeline. Each base rental and each paid extension appears as a separate row. Query by vehicle_id ORDER BY start_date ASC to get the full chain.';
