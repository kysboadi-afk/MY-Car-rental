-- Migration: add created_at to blocked_dates
-- The blocked_dates table was originally created without a created_at column.
-- The admin UI and API now display/query this field, so we add it here with
-- a default of now() and backfill existing rows to the current timestamp.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blocked_dates' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE blocked_dates
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;
