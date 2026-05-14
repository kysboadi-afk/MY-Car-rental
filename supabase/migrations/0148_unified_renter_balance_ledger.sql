-- Migration 0148: Unified renter balance ledger (Phase 1 foundation)
--
-- Goal:
--   Single append-only transaction ledger for all renter/booking debt events.
--   Balances must be derived from transactions, never manually overwritten.

CREATE TABLE IF NOT EXISTS renter_balance_ledger (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                text NOT NULL,
  customer_id               uuid REFERENCES customers(id) ON DELETE SET NULL,
  transaction_type          text NOT NULL CHECK (
    transaction_type IN (
      'extension',
      'late_fee',
      'ticket',
      'damage',
      'repair',
      'deductible',
      'smoking',
      'cleaning',
      'towing',
      'misc',
      'payment',
      'refund',
      'waiver',
      'adjustment'
    )
  ),
  direction                 text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount                    numeric(10,2) NOT NULL CHECK (amount > 0),
  notes                     text,
  source_type               text,
  source_id                 text,
  stripe_payment_intent_id  text,
  related_charge_id         uuid REFERENCES charges(id) ON DELETE SET NULL,
  related_ticket_id         uuid REFERENCES tickets(id) ON DELETE SET NULL,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by                text NOT NULL DEFAULT 'system',
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT renter_balance_ledger_source_pair_chk
    CHECK (
      (source_type IS NULL AND source_id IS NULL)
      OR
      (source_type IS NOT NULL AND source_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_booking_idx
  ON renter_balance_ledger (booking_id);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_customer_idx
  ON renter_balance_ledger (customer_id);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_created_at_idx
  ON renter_balance_ledger (created_at DESC);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_booking_created_idx
  ON renter_balance_ledger (booking_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS renter_balance_ledger_source_unique_idx
  ON renter_balance_ledger (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

COMMENT ON TABLE renter_balance_ledger IS
  'Append-only renter/booking balance ledger. Outstanding balance is derived from entries, never manually overwritten.';

COMMENT ON COLUMN renter_balance_ledger.direction IS
  'debit increases amount owed by renter; credit decreases amount owed.';

CREATE OR REPLACE FUNCTION fn_prevent_renter_balance_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'renter_balance_ledger is append-only (% not allowed)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_update ON renter_balance_ledger;
DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_delete ON renter_balance_ledger;

CREATE TRIGGER trg_renter_balance_ledger_no_update
  BEFORE UPDATE ON renter_balance_ledger
  FOR EACH ROW
  EXECUTE FUNCTION fn_prevent_renter_balance_ledger_mutation();

CREATE TRIGGER trg_renter_balance_ledger_no_delete
  BEFORE DELETE ON renter_balance_ledger
  FOR EACH ROW
  EXECUTE FUNCTION fn_prevent_renter_balance_ledger_mutation();

CREATE OR REPLACE VIEW renter_balance_ledger_summary AS
WITH grouped AS (
  SELECT
    booking_id,
    customer_id,
    SUM(CASE WHEN direction = 'debit'  THEN amount ELSE 0 END) AS debit_total,
    SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) AS credit_total,
    COUNT(*)::bigint AS transaction_count,
    MAX(created_at) AS last_transaction_at
  FROM renter_balance_ledger
  GROUP BY booking_id, customer_id
)
SELECT
  booking_id,
  customer_id,
  ROUND(debit_total::numeric, 2) AS total_charges,
  ROUND(credit_total::numeric, 2) AS total_credits,
  ROUND((debit_total - credit_total)::numeric, 2) AS net_balance,
  transaction_count,
  last_transaction_at
FROM grouped;
