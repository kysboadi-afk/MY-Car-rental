-- Migration 0119: Add unconditional unique index to sms_logs
--
-- Background:
--   Migration 0077 dropped the table-level UNIQUE constraint sms_logs_dedup and
--   replaced it with a partial unique index sms_logs_dedup_idx:
--
--     CREATE UNIQUE INDEX sms_logs_dedup_idx
--       ON sms_logs (booking_id, template_key, return_date_at_send)
--       WHERE template_key <> 'HIGH_DAILY_MILEAGE';
--
--   PostgreSQL requires that an ON CONFLICT (col1, col2, col3) inference target
--   exactly matches its arbiter index, INCLUDING any predicate.  Because PostgREST
--   emits ON CONFLICT (booking_id, template_key, return_date_at_send) WITHOUT a
--   WHERE clause, Postgres cannot infer sms_logs_dedup_idx as the arbiter and
--   throws "no unique or exclusion constraint matching the ON CONFLICT
--   specification" for every upsert — even for non-HIGH_DAILY_MILEAGE rows.
--
-- Fix:
--   Add a full (non-partial) unconditional unique index that PostgREST can use
--   for conflict inference regardless of the template_key value.  The existing
--   partial index is kept; it becomes logically redundant alongside this one but
--   is harmless and can be dropped separately after verification.
--
--   For HIGH_DAILY_MILEAGE rows: application code (logHighMileageAlert) uses a
--   plain INSERT and silences 23505 (unique_violation) so that a duplicate
--   same-day log entry is gracefully skipped.  The hard cap (2 per booking) and
--   60-minute cooldown are enforced before each send by checkHighMileageQuota.

CREATE UNIQUE INDEX IF NOT EXISTS sms_logs_dedup_triplet_unique
  ON public.sms_logs (booking_id, template_key, return_date_at_send);

COMMENT ON INDEX sms_logs_dedup_triplet_unique IS
  'Full (non-partial) unique index required for PostgREST ON CONFLICT inference. '
  'Fixes "no unique or exclusion constraint matching the ON CONFLICT specification" '
  'that occurred after migration 0077 replaced the table-level constraint with a '
  'partial index. HIGH_DAILY_MILEAGE callers use plain INSERT and silence 23505.';
