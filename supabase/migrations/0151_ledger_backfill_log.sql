-- Migration 0151: Ledger Backfill Log
--
-- Provides a resumable cursor and audit trail for the one-time ledger backfill
-- job (api/ledger-backfill.js).  Each row records the outcome of replaying a
-- single source event into the renter_balance_ledger table.
--
-- status values:
--   ok      – transaction inserted (or already existed; idempotent)
--   skip    – skipped (no ledger-eligible data, e.g. missing payment_intent_id)
--   error   – insert attempt failed; error_message captures the reason

CREATE TABLE IF NOT EXISTS ledger_backfill_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          text        NOT NULL,
  source_table    text        NOT NULL CHECK (source_table IN ('revenue_records', 'charges', 'tickets', 'waiver_events')),
  source_id       text        NOT NULL,
  booking_id      text,
  status          text        NOT NULL CHECK (status IN ('ok', 'skip', 'error')),
  ledger_tx_id    uuid        REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  error_message   text,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_run_idx
  ON ledger_backfill_log (run_id);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_source_idx
  ON ledger_backfill_log (source_table, source_id);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_booking_idx
  ON ledger_backfill_log (booking_id)
  WHERE booking_id IS NOT NULL;

-- Unique constraint so re-runs within the same run_id are idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_backfill_log_run_source_unique_idx
  ON ledger_backfill_log (run_id, source_table, source_id);

COMMENT ON TABLE ledger_backfill_log IS
  'Audit trail and resumable cursor for ledger backfill runs (api/ledger-backfill.js). Each row represents one source event processed.';
