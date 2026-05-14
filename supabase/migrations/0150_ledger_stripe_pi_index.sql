-- Migration 0150: Ledger Phase 3 — stripe_payment_intent_id index
--
-- Adds a fast lookup index for payment-intent-based idempotency checks
-- so duplicate webhook deliveries are resolved in a single indexed seek
-- rather than a full-table scan.

CREATE INDEX IF NOT EXISTS renter_balance_ledger_pi_idx
  ON renter_balance_ledger (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON INDEX renter_balance_ledger_pi_idx IS
  'Fast lookup by Stripe payment_intent_id for webhook idempotency checks (Phase 3).';
