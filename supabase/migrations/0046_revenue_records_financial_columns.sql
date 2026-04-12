-- Migration 0046: ensure all Stripe/financial columns exist on revenue_records
--
-- Comprehensive catchup migration for databases that may have only partially
-- applied migrations 0042–0045.  All ALTER TABLE statements use IF NOT EXISTS
-- so this migration is safe to run on any database state.
--
-- Columns covered (no-ops if already present):
--   original_booking_id — links extension rows back to original booking (0042)
--   payment_intent_id   — Stripe PI id (pi_…) for reconciliation matching (0043)
--   stripe_fee          — Stripe processing fee in USD (0044)
--   stripe_net          — Net payout after Stripe fee in USD (0044)
--   stripe_charge_id    — Stripe Charge ID (ch_…) for direct dedup (0044)
--   sync_excluded       — soft-delete flag; prevents re-sync after admin delete (0045)
--
-- After applying this migration, api/stripe-reconcile.js and api/v2-dashboard.js
-- can safely read and write all of these columns without schema errors.

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS original_booking_id text          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payment_intent_id   text          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_fee          numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_net          numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_charge_id    text          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sync_excluded       boolean       NOT NULL DEFAULT false;

-- ── Indexes (all idempotent) ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS revenue_records_original_booking_id_idx
  ON revenue_records (original_booking_id)
  WHERE original_booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_payment_intent_id_idx
  ON revenue_records (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_stripe_charge_id_idx
  ON revenue_records (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_sync_excluded_idx
  ON revenue_records (sync_excluded)
  WHERE sync_excluded = true;
