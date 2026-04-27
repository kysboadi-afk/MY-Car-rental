-- =============================================================================
-- Migration 0098: Ensure oil_check columns exist on bookings table
-- =============================================================================
--
-- Migration 0079 introduced these columns but was not applied to all
-- environments.  This migration re-applies the same ALTER TABLE statements
-- using ADD COLUMN IF NOT EXISTS so it is fully idempotent and safe to run
-- on databases that already have the columns from 0079.
--
-- Safe to re-run: all statements use ADD COLUMN IF NOT EXISTS.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS last_oil_check_at       timestamptz,
  ADD COLUMN IF NOT EXISTS oil_status              text,
  ADD COLUMN IF NOT EXISTS oil_check_required      boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oil_check_last_request  timestamptz,
  ADD COLUMN IF NOT EXISTS oil_check_missed_count  integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS oil_check_photo_url     text;

DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_oil_status_check
    CHECK (oil_status IN ('full', 'mid', 'low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
