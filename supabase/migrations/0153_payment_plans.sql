-- Migration 0153: Payment Plans + Installments
--
-- Supports multi-installment payment arrangements for renters with outstanding
-- balances.  The ledger architecture makes each installment individually
-- traceable — every installment row links back to its ledger_transaction_id,
-- ensuring partial installment payments reconcile cleanly against ledger totals.
--
-- payment_plans.status:
--   active      – plan is in progress
--   completed   – all installments paid
--   defaulted   – one or more installments failed and no recovery
--   cancelled   – plan cancelled by admin
--
-- payment_plan_installments.status:
--   pending     – not yet due or not yet attempted
--   paid        – successfully charged
--   failed      – charge attempt failed
--   partial     – partial payment applied (remainder still owed)

CREATE TABLE IF NOT EXISTS payment_plans (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        text          NOT NULL REFERENCES bookings(booking_ref) ON DELETE RESTRICT,
  customer_email    text          NOT NULL,
  total_amount      numeric(10,2) NOT NULL CHECK (total_amount > 0),
  installments      integer       NOT NULL CHECK (installments BETWEEN 2 AND 24),
  interval_days     integer       NOT NULL CHECK (interval_days BETWEEN 1 AND 90),
  next_due_date     timestamptz,
  status            text          NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled')),
  notes             text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  created_by        text          NOT NULL DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id               uuid          NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  installment_number    integer       NOT NULL,
  amount                numeric(10,2) NOT NULL CHECK (amount > 0),
  due_date              timestamptz   NOT NULL,
  paid_at               timestamptz,
  payment_intent_id     text,
  ledger_transaction_id uuid          REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  status                text          NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'paid', 'failed', 'partial')),
  failure_message       text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (plan_id, installment_number)
);

CREATE INDEX IF NOT EXISTS payment_plans_booking_idx
  ON payment_plans (booking_id);

CREATE INDEX IF NOT EXISTS payment_plans_customer_email_idx
  ON payment_plans (customer_email);

CREATE INDEX IF NOT EXISTS payment_plans_status_idx
  ON payment_plans (status);

CREATE INDEX IF NOT EXISTS payment_plan_installments_plan_idx
  ON payment_plan_installments (plan_id);

CREATE INDEX IF NOT EXISTS payment_plan_installments_due_date_idx
  ON payment_plan_installments (due_date)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS payment_plan_installments_ledger_idx
  ON payment_plan_installments (ledger_transaction_id)
  WHERE ledger_transaction_id IS NOT NULL;

-- Auto-update updated_at on payment_plans
CREATE OR REPLACE FUNCTION fn_payment_plans_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_plans_updated_at ON payment_plans;
CREATE TRIGGER trg_payment_plans_updated_at
  BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION fn_payment_plans_set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_plan_installments_updated_at ON payment_plan_installments;
CREATE TRIGGER trg_payment_plan_installments_updated_at
  BEFORE UPDATE ON payment_plan_installments
  FOR EACH ROW EXECUTE FUNCTION fn_payment_plans_set_updated_at();

COMMENT ON TABLE payment_plans IS
  'Multi-installment payment plans for renters with outstanding balances. Installments link to renter_balance_ledger via ledger_transaction_id.';

COMMENT ON TABLE payment_plan_installments IS
  'Individual installments within a payment plan. Each paid installment links to its ledger transaction for reconciliation.';
