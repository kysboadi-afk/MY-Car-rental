-- Migration 0130: Tickets / Violations system + booking documents + customer document columns
--
-- Changes:
--   1. tickets table — stores violation tickets linked to bookings and customers
--   2. booking_documents table — stores per-booking file URLs (agreement, insurance, other)
--   3. Adds license_front_url + license_uploaded_at to customers table

-- ── 1. tickets table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number    text          NOT NULL,
  vehicle_id       text          REFERENCES vehicles(vehicle_id) ON DELETE SET NULL,
  booking_id       text          REFERENCES bookings(booking_ref) ON DELETE SET NULL,
  customer_id      uuid          REFERENCES customers(id) ON DELETE SET NULL,
  violation_date   timestamptz   NOT NULL,
  location         text,
  amount           numeric(10,2) NOT NULL CHECK (amount > 0),
  type             text          NOT NULL DEFAULT 'parking',
  status           text          NOT NULL DEFAULT 'new',
  notes            text,
  activity_log     jsonb         NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS tickets_vehicle_id_idx     ON tickets (vehicle_id);
CREATE INDEX IF NOT EXISTS tickets_booking_id_idx     ON tickets (booking_id);
CREATE INDEX IF NOT EXISTS tickets_customer_id_idx    ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx         ON tickets (status);
CREATE INDEX IF NOT EXISTS tickets_violation_date_idx ON tickets (violation_date DESC);
CREATE INDEX IF NOT EXISTS tickets_created_at_idx     ON tickets (created_at DESC);

DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE tickets FROM anon;
REVOKE ALL ON TABLE tickets FROM authenticated;
GRANT ALL ON TABLE tickets TO service_role;

CREATE POLICY IF NOT EXISTS tickets_service_role_all
  ON tickets FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 2. booking_documents table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  text        NOT NULL REFERENCES bookings(booking_ref) ON DELETE CASCADE,
  type        text        NOT NULL DEFAULT 'other',
  file_url    text        NOT NULL,
  file_name   text,
  mime_type   text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE booking_documents ADD CONSTRAINT booking_documents_type_check
    CHECK (type IN ('agreement','insurance','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx ON booking_documents (booking_id);
CREATE INDEX IF NOT EXISTS booking_documents_type_idx       ON booking_documents (type);

ALTER TABLE booking_documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE booking_documents FROM anon;
REVOKE ALL ON TABLE booking_documents FROM authenticated;
GRANT ALL ON TABLE booking_documents TO service_role;

CREATE POLICY IF NOT EXISTS booking_documents_service_role_all
  ON booking_documents FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. Customer document columns ──────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS license_front_url    text,
  ADD COLUMN IF NOT EXISTS license_uploaded_at  timestamptz;
