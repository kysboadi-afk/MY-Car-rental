-- Migration 0148: Customer ledger — Phase A foundation
--
-- PHASE A: Additive schema only. Zero production behavior changes.
--
-- What this migration does:
--   1. Extends `customers` with identity-normalization and migration-tracking columns.
--   2. Creates `customer_ledger`            — append-only financial ledger per customer.
--   3. Creates `customer_migration_log`     — audit trail for every customer-link decision.
--   4. Creates `customer_identity_conflicts`— review queue for ambiguous identity matches.
--   5. Creates `ledger_reconciliation_mismatches` — drift log between ledger and legacy.
--   6. Creates `ledger_idempotency_log`     — duplicate-write prevention audit.
--   7. Creates `ledger_rollback_events`     — rollback / replay operation audit.
--   8. Seeds `customer_ledger_mode = 'shadow'` in system_settings.
--
-- Guardrails enforced:
--   • No existing table is altered destructively (all ADD COLUMN IF NOT EXISTS).
--   • No existing view, function, trigger, or RPC is modified.
--   • No Stripe runtime paths are touched.
--   • No enforcement behavior changes — new tables are dormant data structures.
--   • All new tables use append-only + idempotency patterns from day one.
--
-- Safe to re-run: every DDL statement is guarded with IF NOT EXISTS / OR REPLACE.

-- ── 1. Extend `customers` with identity-normalization columns ─────────────────
--
-- normalized_phone  : E.164-like digits-only string (e.g. '+13105551234').
--                     Populated during Phase B backfill; null until then.
-- normalized_email  : Lower-cased, trimmed email (email is already normalised
--                     by migration 0057, so this mirrors that value for
--                     cross-table consistency without a join).
-- stripe_customer_id: Canonical Stripe cus_xxx for this customer entity.
--                     Bookings store their own stripe_customer_id; this column
--                     will hold the single canonical ID after Phase B linking.
-- ledger_migration_status: Lifecycle state for the Phase B backfill process.
--                     pending   → not yet evaluated
--                     migrated  → deterministically linked, ledger populated
--                     conflict  → ambiguous match, routed to identity_conflicts
--                     skipped   → no bookings / nothing to migrate
-- ledger_migrated_at: Timestamp when migration_status was last set to 'migrated'.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS normalized_phone        text,
  ADD COLUMN IF NOT EXISTS normalized_email        text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id      text,
  ADD COLUMN IF NOT EXISTS ledger_migration_status text NOT NULL DEFAULT 'pending'
    CHECK (ledger_migration_status IN ('pending','migrated','conflict','skipped')),
  ADD COLUMN IF NOT EXISTS ledger_migrated_at      timestamptz;

-- Index: deterministic phone match (Phase B linking)
CREATE INDEX IF NOT EXISTS customers_normalized_phone_idx
  ON customers (normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- Index: deterministic email match (Phase B linking)
CREATE INDEX IF NOT EXISTS customers_normalized_email_idx
  ON customers (normalized_email)
  WHERE normalized_email IS NOT NULL;

-- Index: Stripe customer ID match (Phase B linking)
CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_customer_id_idx
  ON customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Index: migration backfill cursor
CREATE INDEX IF NOT EXISTS customers_ledger_migration_status_idx
  ON customers (ledger_migration_status);

-- ── 2. `customer_ledger` — append-only financial ledger ───────────────────────
--
-- Each row is a single immutable financial event for a customer.
-- Debits (charges, fees) have direction='debit',  amount_cents > 0.
-- Credits (payments, refunds, waivers) have direction='credit', amount_cents > 0.
-- The net balance is SUM(debit) − SUM(credit).
--
-- The UNIQUE constraint on (source_type, source_id) is the idempotency gate:
-- any duplicate write resolves to a conflict at the DB layer rather than a
-- phantom row.  All write helpers must use ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS customer_ledger (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  booking_ref      text,                   -- bookings.booking_ref; nullable (customer-level entries)
  transaction_type text        NOT NULL
    CHECK (transaction_type IN (
      'rental_charge',
      'extension_charge',
      'late_fee',
      'ticket_charge',
      'manual_charge',
      'stripe_payment',
      'stripe_refund',
      'admin_waiver',
      'balance_payment',
      'payment_plan_installment'
    )),
  direction        text        NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents     integer     NOT NULL CHECK (amount_cents >= 0),
  source_type      text        NOT NULL,   -- matches transaction_type for most entries
  source_id        text        NOT NULL,   -- idempotency key (pi_id, charge_id, etc.)
  description      text,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by      text,                   -- 'stripe_webhook' | 'admin' | 'backfill' | 'system'

  -- Idempotency constraint — the sole mechanism preventing duplicate entries.
  CONSTRAINT customer_ledger_source_unique UNIQUE (source_type, source_id)
);

-- Indexes for balance queries and audit lookups
CREATE INDEX IF NOT EXISTS customer_ledger_customer_id_idx
  ON customer_ledger (customer_id);

CREATE INDEX IF NOT EXISTS customer_ledger_booking_ref_idx
  ON customer_ledger (booking_ref)
  WHERE booking_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_ledger_created_at_idx
  ON customer_ledger (created_at DESC);

CREATE INDEX IF NOT EXISTS customer_ledger_source_type_idx
  ON customer_ledger (source_type);

-- ── 3. `customer_migration_log` — backfill audit trail ───────────────────────
--
-- One row per customer-link decision made during Phase B backfill.
-- confidence_tier values:
--   exact_stripe_id  → booking.stripe_customer_id === customers.stripe_customer_id
--   exact_email      → booking.customer_email    === customers.email (normalised)
--   exact_phone      → booking.customer_phone    === customers.normalized_phone
--   ambiguous        → fell through all deterministic tiers; routed to conflict queue
-- action:
--   linked           → booking linked to this customer record
--   conflict_created → entry written to customer_identity_conflicts
--   skipped          → no match possible / nothing to do

CREATE TABLE IF NOT EXISTS customer_migration_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        REFERENCES customers(id) ON DELETE SET NULL,
  booking_ref      text,
  confidence_tier  text        NOT NULL
    CHECK (confidence_tier IN (
      'exact_stripe_id',
      'exact_email',
      'exact_phone',
      'ambiguous'
    )),
  action           text        NOT NULL
    CHECK (action IN ('linked','conflict_created','skipped')),
  match_details    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  migrated_by      text,       -- 'backfill_script' | 'admin_manual'
  migrated_at      timestamptz NOT NULL DEFAULT now(),
  notes            text
);

CREATE INDEX IF NOT EXISTS customer_migration_log_customer_id_idx
  ON customer_migration_log (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_migration_log_booking_ref_idx
  ON customer_migration_log (booking_ref)
  WHERE booking_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_migration_log_confidence_tier_idx
  ON customer_migration_log (confidence_tier);

CREATE INDEX IF NOT EXISTS customer_migration_log_action_idx
  ON customer_migration_log (action);

-- ── 4. `customer_identity_conflicts` — manual review queue ───────────────────
--
-- Populated only when confidence_tier = 'ambiguous'.
-- Nothing auto-merges from this table.  An admin must set status='resolved'
-- with a chosen customer_id before any ledger linking occurs.
-- status values:
--   pending   → awaiting admin review
--   resolved  → admin chose a canonical customer_id
--   dismissed → admin determined no valid match; booking remains unlinked

CREATE TABLE IF NOT EXISTS customer_identity_conflicts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref           text        NOT NULL,
  candidate_customer_ids jsonb      NOT NULL DEFAULT '[]'::jsonb,
  conflict_reason       text        NOT NULL,
  raw_booking_data      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolved','dismissed')),
  resolved_customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  resolved_by           text,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_identity_conflicts_booking_ref_idx
  ON customer_identity_conflicts (booking_ref);

CREATE INDEX IF NOT EXISTS customer_identity_conflicts_status_idx
  ON customer_identity_conflicts (status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION _set_customer_identity_conflicts_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_identity_conflicts_updated_at
  ON customer_identity_conflicts;

CREATE TRIGGER customer_identity_conflicts_updated_at
  BEFORE UPDATE ON customer_identity_conflicts
  FOR EACH ROW EXECUTE FUNCTION _set_customer_identity_conflicts_updated_at();

-- ── 5. `ledger_reconciliation_mismatches` — drift audit ──────────────────────
--
-- Populated by the reconciliation cron / shadow-validation step.
-- Each row records one instance where ledger-derived balance ≠ legacy balance.
-- drift_cents = ledger_balance_cents − legacy_balance_cents.
-- status:
--   open        → unresolved mismatch
--   explained   → mismatch understood (e.g. timing, pending entry)
--   resolved    → ledger corrected or legacy corrected

CREATE TABLE IF NOT EXISTS ledger_reconciliation_mismatches (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid        REFERENCES customers(id) ON DELETE SET NULL,
  booking_ref           text,
  ledger_balance_cents  integer     NOT NULL,
  legacy_balance_cents  integer     NOT NULL,
  drift_cents           integer     NOT NULL
    GENERATED ALWAYS AS (ledger_balance_cents - legacy_balance_cents) STORED,
  drift_direction       text        NOT NULL
    CHECK (drift_direction IN ('ledger_higher','ledger_lower','match')),
  detected_at           timestamptz NOT NULL DEFAULT now(),
  detection_run_id      text,       -- correlates rows from a single cron run
  status                text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','explained','resolved')),
  explanation           text,
  resolved_by           text,
  resolved_at           timestamptz,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_customer_id_idx
  ON ledger_reconciliation_mismatches (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_status_idx
  ON ledger_reconciliation_mismatches (status);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_detected_at_idx
  ON ledger_reconciliation_mismatches (detected_at DESC);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_run_id_idx
  ON ledger_reconciliation_mismatches (detection_run_id)
  WHERE detection_run_id IS NOT NULL;

-- ── 6. `ledger_idempotency_log` — duplicate-write prevention audit ────────────
--
-- Populated whenever a ledger write attempt is rejected by the
-- (source_type, source_id) unique constraint (ON CONFLICT DO NOTHING path).
-- This makes duplicate-write prevention visible rather than silent.

CREATE TABLE IF NOT EXISTS ledger_idempotency_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text        NOT NULL,
  source_id    text        NOT NULL,
  caller       text,       -- which API endpoint / cron attempted the write
  booking_ref  text,
  customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ledger_idempotency_log_source_idx
  ON ledger_idempotency_log (source_type, source_id);

CREATE INDEX IF NOT EXISTS ledger_idempotency_log_attempted_at_idx
  ON ledger_idempotency_log (attempted_at DESC);

-- ── 7. `ledger_rollback_events` — rollback / replay audit ────────────────────
--
-- Records every time a ledger mode change or rollback/replay operation occurs.
-- event_type:
--   mode_change  → CUSTOMER_LEDGER_MODE setting changed
--   rollback     → explicit rollback of ledger entries for a booking/customer
--   replay       → explicit re-processing of source events into the ledger

CREATE TABLE IF NOT EXISTS ledger_rollback_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text        NOT NULL
    CHECK (event_type IN ('mode_change','rollback','replay')),
  previous_mode text,
  new_mode      text,
  scope_type   text,       -- 'global' | 'customer' | 'booking'
  scope_id     text,       -- customer_id or booking_ref when scoped
  initiated_by text        NOT NULL,
  reason       text,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_rollback_events_event_type_idx
  ON ledger_rollback_events (event_type);

CREATE INDEX IF NOT EXISTS ledger_rollback_events_created_at_idx
  ON ledger_rollback_events (created_at DESC);

-- ── 8. Seed `customer_ledger_mode` in system_settings ────────────────────────
--
-- Controls which balance/enforcement path is canonical.
--   shadow   → ledger writes are dormant; legacy paths are sole authority (DEFAULT)
--   parallel → both paths run; results compared; no enforcement from ledger
--   warn     → ledger runs; mismatches generate admin alerts; no hard blocks
--   review   → ledger mismatches route new bookings to admin review queue
--   block    → ledger is canonical; non-zero balance blocks new bookings
--
-- Default is 'shadow' — no production behavior change until explicitly promoted.

INSERT INTO system_settings (key, value, description, category)
VALUES (
  'customer_ledger_mode',
  '"shadow"',
  'Customer ledger enforcement mode. '
    'shadow=dormant (legacy only), parallel=dual-run+compare, '
    'warn=ledger alerts, review=admin queue routing, block=ledger canonical. '
    'Do not advance past shadow until Phase D reconciliation thresholds are met.',
  'ledger'
)
ON CONFLICT (key) DO NOTHING;
