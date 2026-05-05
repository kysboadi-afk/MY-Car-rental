-- Migration 0136: Idempotent repair for tickets / booking_documents schema
--
-- Migrations 0133–0135 may not have fully applied because 0133 contained
-- invalid "CREATE POLICY IF NOT EXISTS" syntax (PostgreSQL does not support
-- that form), causing Supabase to abort mid-migration.  This migration is a
-- fully idempotent catch-all that brings every table, column, constraint,
-- index, trigger, policy and setting to the correct final state regardless of
-- what was (or was not) applied previously.
--
-- Safe to run on a database where 0133–0135 already applied correctly — every
-- statement uses IF NOT EXISTS / DO ... EXCEPTION WHEN duplicate_object /
-- ON CONFLICT DO NOTHING so nothing is altered twice.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1.  tickets table
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. Create the table with its final schema if it does not exist yet.
--     booking_id is uuid from the start; if the table already exists this
--     statement is a no-op and step 1b handles any missing pieces.
CREATE TABLE IF NOT EXISTS tickets (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number           text          NOT NULL,
  vehicle_id              text          REFERENCES vehicles(vehicle_id) ON DELETE SET NULL,
  booking_id              uuid          REFERENCES bookings(id) ON DELETE SET NULL,
  booking_ref             text,
  customer_id             uuid          REFERENCES customers(id) ON DELETE SET NULL,
  violation_date          timestamptz   NOT NULL,
  location                text,
  amount                  numeric(10,2) NOT NULL CHECK (amount > 0),
  type                    text          NOT NULL DEFAULT 'parking',
  status                  text          NOT NULL DEFAULT 'new',
  notes                   text,
  activity_log            jsonb         NOT NULL DEFAULT '[]'::jsonb,
  renter_responsible      boolean       DEFAULT false,
  admin_fee               numeric(10,2) DEFAULT 25,
  charge_status           text,
  transfer_submitted_at   timestamptz,
  charge_retry_count      integer       NOT NULL DEFAULT 0,
  charge_last_attempted_at timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now()
);

-- 1b. Add any columns that might be missing on a pre-existing table.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS booking_ref              text,
  ADD COLUMN IF NOT EXISTS renter_responsible       boolean       DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_fee                numeric(10,2) DEFAULT 25,
  ADD COLUMN IF NOT EXISTS charge_status            text,
  ADD COLUMN IF NOT EXISTS transfer_submitted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS charge_retry_count       integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_last_attempted_at timestamptz;

-- 1c. If booking_id is still a text column (old FK to bookings.booking_ref),
--     migrate it to a UUID FK pointing at bookings.id.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'tickets'
     AND column_name  = 'booking_id';

  IF col_type = 'text' THEN
    -- Backfill booking_ref from the existing text booking_id value
    UPDATE tickets t
       SET booking_ref = t.booking_id
     WHERE t.booking_id IS NOT NULL
       AND t.booking_ref IS NULL;

    -- Carry the value across to a temp uuid column
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

    UPDATE tickets t
       SET booking_id_uuid = b.id
      FROM bookings b
     WHERE b.booking_ref = t.booking_id
       AND t.booking_id IS NOT NULL;

    -- Drop old text FK
    ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_booking_id_fkey;
    ALTER TABLE tickets DROP COLUMN IF EXISTS booking_id;

    -- Promote temp column
    ALTER TABLE tickets RENAME COLUMN booking_id_uuid TO booking_id;

  END IF;
END $$;

-- 1d. Ensure the UUID FK constraint exists (idempotent).
DO $$
BEGIN
  ALTER TABLE tickets
    ADD CONSTRAINT tickets_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1e. Constraints (idempotent).
DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_type_check
    CHECK (type IN ('parking','toll','camera','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
    CHECK (status IN ('new','matched','transfer_ready','submitted','approved','rejected','charged','closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1f. Indexes.
CREATE INDEX IF NOT EXISTS tickets_vehicle_id_idx      ON tickets (vehicle_id);
CREATE INDEX IF NOT EXISTS tickets_booking_id_idx      ON tickets (booking_id);
CREATE INDEX IF NOT EXISTS tickets_customer_id_idx     ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx          ON tickets (status);
CREATE INDEX IF NOT EXISTS tickets_violation_date_idx  ON tickets (violation_date DESC);
CREATE INDEX IF NOT EXISTS tickets_created_at_idx      ON tickets (created_at DESC);

-- 1g. updated_at trigger.
DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 1h. RLS.
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tickets FROM anon;
REVOKE ALL ON TABLE tickets FROM authenticated;
GRANT ALL ON TABLE tickets TO service_role;

DO $$
BEGIN
  CREATE POLICY tickets_service_role_all
    ON tickets FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2.  booking_documents table
-- ═══════════════════════════════════════════════════════════════════════════

-- 2a. Create with final schema (uuid FK) if it does not exist.
CREATE TABLE IF NOT EXISTS booking_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type        text        NOT NULL DEFAULT 'other',
  file_url    text        NOT NULL,
  file_name   text,
  mime_type   text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- 2b. If booking_id is still a text column, migrate it to uuid.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'booking_documents'
     AND column_name  = 'booking_id';

  IF col_type = 'text' THEN
    ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

    UPDATE booking_documents bd
       SET booking_id_uuid = b.id
      FROM bookings b
     WHERE b.booking_ref = bd.booking_id;

    -- Remove rows that could not be linked
    DELETE FROM booking_documents WHERE booking_id_uuid IS NULL;

    ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_booking_id_fkey;
    ALTER TABLE booking_documents DROP COLUMN IF EXISTS booking_id;

    ALTER TABLE booking_documents RENAME COLUMN booking_id_uuid TO booking_id;
    ALTER TABLE booking_documents ALTER COLUMN booking_id SET NOT NULL;
  END IF;
END $$;

-- 2c. Ensure UUID FK constraint exists.
DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2d. Widen type CHECK to include 'id_copy' (drop old, add new).
DO $$
BEGIN
  ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_type_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_type_check
    CHECK (type IN ('agreement','insurance','other','id_copy'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2e. Indexes.
DROP   INDEX IF EXISTS booking_documents_booking_id_idx;
CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx ON booking_documents (booking_id);
CREATE INDEX IF NOT EXISTS booking_documents_type_idx       ON booking_documents (type);

-- 2f. RLS.
ALTER TABLE booking_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE booking_documents FROM anon;
REVOKE ALL ON TABLE booking_documents FROM authenticated;
GRANT ALL ON TABLE booking_documents TO service_role;

DO $$
BEGIN
  CREATE POLICY booking_documents_service_role_all
    ON booking_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.  customers — add document columns
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS license_front_url   text,
  ADD COLUMN IF NOT EXISTS license_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS license_back_url    text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4.  system_settings — seed violation_admin_fee
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO system_settings (key, value, description, category)
VALUES (
  'violation_admin_fee',
  '25',
  'Admin processing fee added to violation ticket charge (USD)',
  'fees'
)
ON CONFLICT (key) DO NOTHING;
