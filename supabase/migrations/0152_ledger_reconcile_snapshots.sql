-- Migration 0152: Ledger Reconciliation Snapshots
--
-- Persists the output of each on-demand or nightly reconciliation run so that
-- the platform has a long-term operational trust record.
--
-- Each snapshot captures:
--   - aggregate KPIs (matched %, discrepancy total, unresolved count)
--   - top-10 largest mismatches as JSONB for quick inspection
--   - the full per-booking detail array as JSONB for drill-down
--   - anomalies detected during the same run

CREATE TABLE IF NOT EXISTS ledger_reconcile_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at              timestamptz NOT NULL DEFAULT now(),
  run_type            text        NOT NULL DEFAULT 'manual' CHECK (run_type IN ('manual', 'nightly')),
  bookings_checked    integer     NOT NULL DEFAULT 0,
  matched_count       integer     NOT NULL DEFAULT 0,
  matched_pct         numeric(5,2),
  unresolved_count    integer     NOT NULL DEFAULT 0,
  discrepancy_total   numeric(12,2) NOT NULL DEFAULT 0,
  largest_mismatches  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  anomalies_count     integer     NOT NULL DEFAULT 0,
  anomaly_types       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  anomaly_detail      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  details_json        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  date_from           text,
  date_to             text,
  duration_ms         integer,
  created_by          text        NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS ledger_reconcile_snapshots_run_at_idx
  ON ledger_reconcile_snapshots (run_at DESC);

CREATE INDEX IF NOT EXISTS ledger_reconcile_snapshots_run_type_idx
  ON ledger_reconcile_snapshots (run_type);

COMMENT ON TABLE ledger_reconcile_snapshots IS
  'Persisted output of each reconciliation run (on-demand or nightly). Provides long-term operational trust records.';
