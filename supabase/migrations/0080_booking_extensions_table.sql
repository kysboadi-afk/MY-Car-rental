-- Migration 0080: dedicated booking_extensions table
--
-- Creates a normalised booking_extensions table so every paid rental extension
-- is tracked as a first-class row rather than a denormalised counter on the
-- bookings row.  Each row carries the Stripe PaymentIntent ID (for deduplication),
-- the extension charge, and the new return date applied.
--
-- Replaces manual writes of bookings.extension_count / bookings.last_extension_at
-- with an auto-maintained Postgres trigger that derives those values by aggregating
-- over booking_extensions rows (COUNT / MAX).
--
-- Historical extensions are backfilled from revenue_records where type='extension'.
--
-- Safe to re-run: all DDL statements use IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.

-- ── 1. Create booking_extensions table ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS booking_extensions (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        text          NOT NULL REFERENCES bookings(booking_ref) ON DELETE CASCADE,
  payment_intent_id text          UNIQUE,
  amount            numeric(10,2) NOT NULL DEFAULT 0,
  new_return_date   date          NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  booking_extensions
  IS 'Each row represents one paid rental extension. Linked to bookings via booking_id (= bookings.booking_ref).';
COMMENT ON COLUMN booking_extensions.booking_id
  IS 'booking_ref of the parent booking row (bookings.booking_ref).';
COMMENT ON COLUMN booking_extensions.payment_intent_id
  IS 'Stripe PaymentIntent ID for this extension. UNIQUE; used for idempotent upserts.';
COMMENT ON COLUMN booking_extensions.amount
  IS 'Extension charge in USD.';
COMMENT ON COLUMN booking_extensions.new_return_date
  IS 'The new return date applied by this extension.';

-- ── 2. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS booking_extensions_booking_id_idx
  ON booking_extensions (booking_id);

CREATE INDEX IF NOT EXISTS booking_extensions_created_at_idx
  ON booking_extensions (created_at DESC);

-- ── 3. Trigger: auto-maintain bookings.extension_count / last_extension_at ───
--
-- Fires after every INSERT, UPDATE, or DELETE on booking_extensions and
-- recomputes the two summary columns on the parent bookings row so they
-- are always consistent with the actual extension rows.

CREATE OR REPLACE FUNCTION public.sync_booking_extension_stats()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking_id text;
BEGIN
  v_booking_id := COALESCE(NEW.booking_id, OLD.booking_id);

  UPDATE bookings
  SET
    extension_count   = (SELECT COUNT(*)       FROM booking_extensions WHERE booking_id = v_booking_id),
    last_extension_at = (SELECT MAX(created_at) FROM booking_extensions WHERE booking_id = v_booking_id),
    updated_at        = now()
  WHERE booking_ref = v_booking_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS booking_extensions_sync_stats ON booking_extensions;

CREATE TRIGGER booking_extensions_sync_stats
  AFTER INSERT OR UPDATE OR DELETE ON booking_extensions
  FOR EACH ROW EXECUTE FUNCTION public.sync_booking_extension_stats();

-- ── 4. Backfill from revenue_records ─────────────────────────────────────────
--
-- 4a. Stripe-paid extensions: booking_id = bookings.booking_ref (direct link).

INSERT INTO booking_extensions (booking_id, payment_intent_id, amount, new_return_date, created_at)
SELECT
  rr.booking_id,
  rr.payment_intent_id,
  COALESCE(rr.gross_amount, 0),
  rr.return_date,
  COALESCE(rr.created_at, now())
FROM revenue_records rr
WHERE rr.type           = 'extension'
  AND rr.payment_status = 'paid'
  AND rr.is_cancelled   = false
  AND rr.booking_id     IS NOT NULL
  AND rr.return_date    IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM bookings WHERE booking_ref = rr.booking_id
  )
ON CONFLICT (payment_intent_id) DO NOTHING;

-- 4b. Manually-created extensions: original_booking_id = bookings.booking_ref.
--     These have a synthetic booking_id (e.g. "ext-...") so we map via
--     original_booking_id which points to the real booking_ref.

INSERT INTO booking_extensions (booking_id, payment_intent_id, amount, new_return_date, created_at)
SELECT
  rr.original_booking_id,
  rr.payment_intent_id,
  COALESCE(rr.gross_amount, 0),
  rr.return_date,
  COALESCE(rr.created_at, now())
FROM revenue_records rr
WHERE rr.type                = 'extension'
  AND rr.payment_status      = 'paid'
  AND rr.is_cancelled        = false
  AND rr.original_booking_id IS NOT NULL
  AND rr.return_date         IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM bookings WHERE booking_ref = rr.original_booking_id
  )
ON CONFLICT (payment_intent_id) DO NOTHING;
