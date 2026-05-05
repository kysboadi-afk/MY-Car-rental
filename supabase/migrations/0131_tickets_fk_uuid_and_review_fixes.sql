-- Migration 0131: Part 2 review fixes
--
-- Changes:
--   1. tickets.booking_id: change FK from bookings.booking_ref (text) → bookings.id (uuid)
--      and add denormalised booking_ref text column for display
--   2. booking_documents.booking_id: same FK change
--   3. New tickets columns: renter_responsible, admin_fee, charge_status, transfer_submitted_at
--   4. customers: add license_back_url
--   5. booking_documents type check: add 'id_copy'
--   6. Ensure indexes on tickets(vehicle_id), tickets(customer_id), tickets(violation_date)

-- ── 1. tickets table ─────────────────────────────────────────────────────────
-- 1a. Add denormalised booking_ref text column (for display / human-readable ID)
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS booking_ref text;

-- 1b. Add new operational columns
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS renter_responsible   boolean       DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_fee            numeric(10,2) DEFAULT 25,
  ADD COLUMN IF NOT EXISTS charge_status        text,
  ADD COLUMN IF NOT EXISTS transfer_submitted_at timestamptz;

-- 1c. Backfill booking_ref from bookings (where FK currently stores booking_ref text)
UPDATE tickets t
SET    booking_ref = t.booking_id
WHERE  t.booking_id IS NOT NULL
  AND  t.booking_ref IS NULL;

-- 1d. Add a temp UUID column, backfill it from bookings.id, then swap
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

UPDATE tickets t
SET    booking_id_uuid = b.id
FROM   bookings b
WHERE  b.booking_ref = t.booking_id
  AND  t.booking_id IS NOT NULL;

-- 1e. Drop the old text FK column (constraint drops with it)
DO $$
BEGIN
  -- Drop named FK constraint if it exists
  ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_booking_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE tickets DROP COLUMN IF EXISTS booking_id;

-- 1f. Rename temp column to booking_id
ALTER TABLE tickets RENAME COLUMN booking_id_uuid TO booking_id;

-- 1g. Add new UUID FK
DO $$
BEGIN
  ALTER TABLE tickets
    ADD CONSTRAINT tickets_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1h. Recreate index on new uuid column
DROP   INDEX IF EXISTS tickets_booking_id_idx;
CREATE INDEX IF NOT EXISTS tickets_booking_id_idx ON tickets (booking_id);

-- Ensure other required indexes exist (idempotent)
CREATE INDEX IF NOT EXISTS tickets_vehicle_id_idx     ON tickets (vehicle_id);
CREATE INDEX IF NOT EXISTS tickets_customer_id_idx    ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS tickets_violation_date_idx ON tickets (violation_date DESC);

-- ── 2. booking_documents table ────────────────────────────────────────────────
-- 2a. Add temp UUID column, backfill, swap
ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

UPDATE booking_documents bd
SET    booking_id_uuid = b.id
FROM   bookings b
WHERE  b.booking_ref = bd.booking_id;

-- Remove rows that could not be linked (orphan rows in newly-created table)
DELETE FROM booking_documents WHERE booking_id_uuid IS NULL;

-- 2b. Drop old text FK column
DO $$
BEGIN
  ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_booking_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE booking_documents DROP COLUMN IF EXISTS booking_id;

-- 2c. Rename, add NOT NULL, add FK
ALTER TABLE booking_documents RENAME COLUMN booking_id_uuid TO booking_id;
ALTER TABLE booking_documents ALTER COLUMN booking_id SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2d. Recreate index
DROP   INDEX IF EXISTS booking_documents_booking_id_idx;
CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx ON booking_documents (booking_id);

-- 2e. Widen type CHECK to include 'id_copy'
DO $$
BEGIN
  ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_type_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_type_check
    CHECK (type IN ('agreement', 'insurance', 'other', 'id_copy'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. customers: add license_back_url ────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS license_back_url text;
