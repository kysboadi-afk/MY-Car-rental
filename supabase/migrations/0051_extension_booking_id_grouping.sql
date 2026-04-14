-- Migration 0051: use original booking_id for extension revenue records
--
-- The previous approach (migration 0050) used the extension PaymentIntent ID
-- as booking_id for extension rows.  This breaks joins and analytics because
-- different booking_id values prevent grouping all records for a single rental.
--
-- New rule:
--   Extension revenue records share the same booking_id as the original rental:
--     booking_id          = original booking_id  (groups all records per rental)
--     payment_intent_id   = extension PaymentIntent ID (unique per payment)
--     type                = 'extension'
--
-- To support multiple rows per booking_id the old full UNIQUE constraint on
-- booking_id is replaced with:
--   1. A PARTIAL unique index on (booking_id) WHERE type = 'rental'
--      → still prevents duplicate rental records per booking.
--   2. A unique index on payment_intent_id (where not null)
--      → prevents duplicate rows for the same Stripe payment.
--
-- Safe to re-run: all statements use IF NOT EXISTS / DROP IF EXISTS patterns.

-- ── 1. Drop the old full unique constraint ────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE  table_name      = 'revenue_records'
      AND  constraint_name = 'revenue_records_booking_id_unique'
      AND  constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE revenue_records
      DROP CONSTRAINT revenue_records_booking_id_unique;
  END IF;
END $$;

-- ── 2. Replace with a partial unique index for rental rows ────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS revenue_records_rental_booking_id_unique
  ON revenue_records (booking_id)
  WHERE type = 'rental';

-- ── 3. Add a unique index on payment_intent_id for dedup ─────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS revenue_records_payment_intent_id_unique
  ON revenue_records (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
