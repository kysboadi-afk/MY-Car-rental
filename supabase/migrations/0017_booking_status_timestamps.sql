-- =============================================================================
-- SLY RIDES — Migration 0017: Booking Status Timestamps
-- =============================================================================
--
-- What this migration does:
--   1. Adds activated_at and completed_at timestamp columns to the bookings
--      table so each booking records exactly when it became active (vehicle
--      picked up) and when it was marked completed (rental finished).
--   2. Adds a BEFORE INSERT OR UPDATE trigger on_booking_status_timestamps that
--      auto-stamps those columns the moment the status column is set to
--      'active' or 'completed', keeping the DB in sync with the JS-side
--      completedAt / activatedAt auto-stamps in v2-bookings.js.
--
-- Alignment with JS auto-stamp logic (v2-bookings.js):
--   JS  status "active_rental"    → activatedAt  stamped
--   DB  status 'active'           → activated_at stamped  (this trigger)
--   JS  status "completed_rental" → completedAt  stamped
--   DB  status 'completed'        → completed_at stamped  (this trigger)
--
-- The BOOKING_STATUS_MAP in _booking-automation.js converts JS statuses to DB
-- statuses before upserting, so the trigger fires on the correct value.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS and CREATE OR REPLACE / DROP IF EXISTS.
-- =============================================================================

-- ── 1. Add new timestamp columns ─────────────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS activated_at  timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at  timestamptz;

-- ── 2. BEFORE trigger function — stamp activated_at / completed_at ────────────
CREATE OR REPLACE FUNCTION on_booking_status_timestamps()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only act when the status is changing (or on first INSERT)
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  CASE NEW.status
    WHEN 'active' THEN
      -- Stamp activated_at the first time status becomes active; preserve any
      -- value already set (e.g. passed explicitly by the API).
      IF NEW.activated_at IS NULL THEN
        NEW.activated_at := now();
      END IF;

    WHEN 'completed' THEN
      -- Stamp completed_at the first time status becomes completed; preserve
      -- any value already set by the JS auto-stamp in v2-bookings.js.
      IF NEW.completed_at IS NULL THEN
        NEW.completed_at := now();
      END IF;

  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_status_timestamps ON bookings;
CREATE TRIGGER bookings_status_timestamps
  BEFORE INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_timestamps();

-- =============================================================================
-- DONE
-- bookings now has activated_at and completed_at columns.
-- on_booking_status_timestamps auto-stamps them on status transitions,
-- mirroring the JS-side activatedAt / completedAt logic in v2-bookings.js.
-- =============================================================================
