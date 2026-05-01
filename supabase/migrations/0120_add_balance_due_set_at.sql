-- Migration 0120: add balance_due_set_at to bookings
-- balance_due_set_at records the exact moment balance_due was first set to a
-- positive value for the current unpaid cycle.  It is cleared back to NULL
-- whenever balance_due drops to 0 (i.e. the balance is paid or waived) so that
-- a fresh timestamp is captured if the booking incurs a new balance in the
-- future.
--
-- Using this column (instead of updated_at) as the retry-window base in
-- scheduled-reminders.js prevents past/completed renters from receiving
-- late-payment SMS messages when their booking row is touched for unrelated
-- reasons (admin edits, extension updates, etc.) long after the original
-- balance was first recorded.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS balance_due_set_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN bookings.balance_due_set_at IS
  'Timestamp when balance_due was first set to a positive value for the '
  'current unpaid cycle. Cleared to NULL when balance_due is paid/waived so '
  'that a fresh timestamp is captured on the next failure. Used by '
  'scheduled-reminders.js as the authoritative base time for retry windows, '
  'instead of updated_at which changes on every row update.';

-- ── Trigger: auto-maintain balance_due_set_at ────────────────────────────────
-- Fires BEFORE UPDATE on bookings whenever balance_due changes.
--   • balance_due goes positive (0/NULL → >0) and balance_due_set_at is NULL:
--     set balance_due_set_at = NOW().
--   • balance_due drops to 0 or NULL (paid / waived): clear balance_due_set_at.
-- The trigger intentionally does NOT overwrite balance_due_set_at if it is
-- already non-NULL, so that repeated PAYMENT_FAILED webhooks for the same
-- unpaid balance do not reset the timer.

CREATE OR REPLACE FUNCTION fn_set_balance_due_set_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Balance becomes positive for the first time this cycle.
  IF NEW.balance_due > 0 AND NEW.balance_due_set_at IS NULL THEN
    NEW.balance_due_set_at := NOW();
  END IF;

  -- Balance is cleared (paid or waived) — reset so next failure gets a fresh
  -- timestamp.
  IF (NEW.balance_due IS NULL OR NEW.balance_due <= 0) THEN
    NEW.balance_due_set_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_balance_due_set_at ON bookings;

CREATE TRIGGER trg_balance_due_set_at
  BEFORE UPDATE OF balance_due ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_balance_due_set_at();
