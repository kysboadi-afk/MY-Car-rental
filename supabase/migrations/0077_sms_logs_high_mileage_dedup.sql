-- Migration 0077: Relax sms_logs uniqueness for HIGH_DAILY_MILEAGE alerts
--
-- Background:
--   The original sms_logs_dedup constraint is UNIQUE(booking_id, template_key,
--   return_date_at_send).  For return-time SMS this works perfectly: each message
--   fires exactly once per return date, and extending a booking allows the new
--   return-date messages to fire again.
--
--   The HIGH_DAILY_MILEAGE owner alert is NOT tied to a return date.  The previous
--   implementation worked around the constraint by storing fake sentinel dates
--   ('1970-01-01', '1970-01-02').  This migration removes that hack by converting
--   the constraint into a partial unique index that excludes HIGH_DAILY_MILEAGE rows,
--   so those rows can store the real calendar date when each alert was sent.
--
-- Effect on existing behaviour:
--   • All other template keys retain the same UNIQUE(booking_id, template_key,
--     return_date_at_send) guarantee — no functional change.
--   • HIGH_DAILY_MILEAGE rows are no longer subject to the unique constraint;
--     the max-2 cap and 60-minute cooldown are enforced in application code
--     (api/maintenance-alerts.js :: checkHighMileageQuota).

-- 1. Drop the old table-level constraint
ALTER TABLE sms_logs DROP CONSTRAINT IF EXISTS sms_logs_dedup;

-- 2. Re-add deduplication as a partial unique index covering every template key
--    except HIGH_DAILY_MILEAGE.  Rows for that key can now coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS sms_logs_dedup_idx
  ON sms_logs (booking_id, template_key, return_date_at_send)
  WHERE template_key <> 'HIGH_DAILY_MILEAGE';

COMMENT ON INDEX sms_logs_dedup_idx IS
  'Prevents duplicate sends for all template keys except HIGH_DAILY_MILEAGE, '
  'which enforces its own cap (MAX 2) and 60-minute cooldown in application code.';
