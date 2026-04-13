-- Migration 0050: extension revenue records pipeline
--
-- Standardises how paid rental extensions are tracked in revenue_records:
--   • Adds `type` column (text NOT NULL DEFAULT 'rental') so extension rows
--     can be distinguished from the original rental row.
--   • Adds `customer_id` column (uuid, FK to customers) so every revenue record
--     carries the full booking_id / customer_id / vehicle_id triple required
--     by the extension pipeline.
--
-- Extension rule (enforced by stripe-webhook.js after this migration):
--   When an extension payment succeeds the webhook:
--     1. Updates the existing booking row (return_date, amountPaid).
--     2. Creates a NEW revenue_records row:
--          booking_id        = extension PaymentIntent ID (unique per payment)
--          original_booking_id = original booking_id (links back to rental row)
--          type              = 'extension'
--          customer_id       = customers.id (looked up by phone / email)
--          vehicle_id        = vehicle_id
--          gross_amount      = extension charge
--     3. Does NOT mutate the original rental revenue_records row.
--     4. Extends blocked_dates accordingly.
--
-- Safe to re-run: all ALTER TABLE statements use IF NOT EXISTS.

-- ── 1. Add type column ────────────────────────────────────────────────────────

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'rental';

-- Backfill any pre-existing rows that were created before this migration.
UPDATE revenue_records
SET    type = 'extension'
WHERE  type = 'rental'
  AND  original_booking_id IS NOT NULL
  AND  original_booking_id <> booking_id;

-- ── 2. Add customer_id column ─────────────────────────────────────────────────

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

-- Backfill customer_id for existing rows using phone → customers lookup.
UPDATE revenue_records rr
SET    customer_id = c.id
FROM   customers c
WHERE  rr.customer_id IS NULL
  AND  rr.customer_phone IS NOT NULL
  AND  c.phone = rr.customer_phone;

-- ── 3. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS revenue_records_type_idx
  ON revenue_records (type);

CREATE INDEX IF NOT EXISTS revenue_records_customer_id_idx
  ON revenue_records (customer_id)
  WHERE customer_id IS NOT NULL;
