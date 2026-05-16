-- Migration 0156: Payment plan reconciliation and allocation audit trail.
--
-- Adds running amount tracking on installments so partial/multi-installment
-- allocations can be reconciled automatically from renter self-payments.
-- Adds payment_plan_allocations table for explicit audit visibility.

ALTER TABLE payment_plan_installments
  ADD COLUMN IF NOT EXISTS amount_paid numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  ADD COLUMN IF NOT EXISTS last_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS last_ledger_transaction_id uuid REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_allocation_at timestamptz;

CREATE TABLE IF NOT EXISTS payment_plan_allocations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                 uuid NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  installment_id          uuid REFERENCES payment_plan_installments(id) ON DELETE SET NULL,
  booking_id              text NOT NULL REFERENCES bookings(booking_ref) ON DELETE RESTRICT,
  stripe_payment_intent_id text NOT NULL,
  ledger_transaction_id   uuid REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  amount_allocated        numeric(10,2) NOT NULL CHECK (amount_allocated >= 0),
  allocation_order        integer NOT NULL CHECK (allocation_order >= 1),
  allocation_type         text NOT NULL DEFAULT 'installment_paid'
    CHECK (allocation_type IN ('installment_paid', 'installment_partial', 'overpayment_unapplied')),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_plan_allocations_pi_order_uidx
  ON payment_plan_allocations (stripe_payment_intent_id, allocation_order);

CREATE INDEX IF NOT EXISTS payment_plan_allocations_booking_idx
  ON payment_plan_allocations (booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_plan_allocations_plan_idx
  ON payment_plan_allocations (plan_id, installment_id);
