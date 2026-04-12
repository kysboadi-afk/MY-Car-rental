-- Migration 0044: add Stripe fee columns to revenue_records
--
-- Enables fully accurate financial tracking using Stripe as the source of
-- truth.  Each Stripe payment's balance_transaction exposes:
--   fee  → Stripe's processing fee (in cents, stored here in dollars)
--   net  → amount actually paid out after the fee
--
-- Three new columns:
--   stripe_fee       — Stripe processing fee in USD (null for cash/manual)
--   stripe_net       — Net payout in USD after Stripe fee (null for cash/manual)
--   stripe_charge_id — Stripe Charge ID (ch_…) for direct lookup; nullable
--
-- Cash / manual payments:  stripe_fee = 0, stripe_net = gross_amount
-- Stripe payments:         populated by api/stripe-reconcile.js
-- Null values:             record has not yet been reconciled with Stripe

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS stripe_fee       numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_net       numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_charge_id text          DEFAULT NULL;

-- Index for dedup checks during reconciliation (charge_id uniqueness)
CREATE INDEX IF NOT EXISTS revenue_records_stripe_charge_id_idx
  ON revenue_records (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;
