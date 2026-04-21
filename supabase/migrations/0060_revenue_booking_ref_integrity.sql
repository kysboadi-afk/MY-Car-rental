-- Migration 0060: enforce revenue_records.booking_id → bookings.booking_ref integrity
--
-- Problem:
--   A successful Stripe payment could create a revenue_records row while the
--   corresponding bookings row was absent (partial pipeline failure or legacy gap),
--   producing an "orphan revenue record" visible in the Revenue tab but invisible
--   in the Bookings page.
--
-- Fix — two parts:
--
--   1. Pre-flight: mark any existing revenue_records rows whose booking_id has NO
--      matching bookings.booking_ref as is_orphan = true so they are excluded from
--      financial reporting and exempt from the new trigger.
--
--   2. Trigger check_revenue_booking_ref:
--      • Fires BEFORE INSERT OR UPDATE on revenue_records.
--      • Skips rows already flagged as is_orphan = true (already excluded from
--        reporting; orphan marking is the deliberate escape hatch).
--      • Skips rows with sync_excluded = true (soft-deleted records).
--      • For all other rows: raises an exception unless booking_id appears in
--        bookings.booking_ref so the row can never be written without a real booking.
--
-- Why a trigger instead of a FK constraint?
--   revenue_records.booking_id is TEXT (stores booking_ref strings like "bk-ro-2026-0401")
--   while bookings.booking_ref is also TEXT UNIQUE.  PostgreSQL allows FK references
--   across text columns but only if both sides share the same collation.  A trigger is
--   more portable and lets us add the is_orphan / sync_excluded escape hatch cleanly
--   without a partial-index FK (which PostgreSQL does not support).
--
-- Safe to re-run: all statements use CREATE OR REPLACE / IF NOT EXISTS / DO $$ guards.

-- ── 1. Pre-flight: mark unlinked existing rows as orphans ─────────────────────
-- Any revenue record whose booking_id is not present in bookings.booking_ref is
-- already an orphan.  Stamp them so they are excluded from reporting and exempt
-- from the new trigger.  Use is_orphan=false guard so repeated runs are idempotent.

UPDATE revenue_records
SET    is_orphan  = true,
       updated_at = now()
WHERE  is_orphan  = false
  AND  sync_excluded = false
  AND  booking_id IS NOT NULL
  AND  NOT EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.booking_id
       );

-- ── 2. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_revenue_booking_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- is_orphan = true  → row is already flagged as having no real booking.
  --                     Allowed so stripe-reconcile and cleanup tools can still
  --                     persist/update these rows without a booking present.
  IF NEW.is_orphan = true THEN
    RETURN NEW;
  END IF;

  -- sync_excluded = true → soft-deleted row; skip the check.
  IF NEW.sync_excluded = true THEN
    RETURN NEW;
  END IF;

  -- Guard: booking_id must have a matching booking_ref in the bookings table.
  IF NEW.booking_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM bookings WHERE booking_ref = NEW.booking_id
  ) THEN
    RAISE EXCEPTION
      'revenue_records integrity violation: booking_id=''%'' has no matching row in bookings.booking_ref. '
      'If this is an intentional orphan record (e.g. from stripe-reconcile auto-create), '
      'set is_orphan = true before inserting.',
      COALESCE(NEW.booking_id, '<null>');
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Attach trigger to revenue_records ─────────────────────────────────────

DROP TRIGGER IF EXISTS revenue_records_booking_ref_check ON revenue_records;

CREATE TRIGGER revenue_records_booking_ref_check
  BEFORE INSERT OR UPDATE ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION public.check_revenue_booking_ref();
