-- Migration 0149: Add due_date to renter_balance_ledger (Phase 2 Add Charge)
--
-- Allows admins to record when a charge becomes due so renters can be
-- reminded before the due date arrives (Phase 5 renter-facing flow).

ALTER TABLE renter_balance_ledger
  ADD COLUMN IF NOT EXISTS due_date date;

CREATE INDEX IF NOT EXISTS renter_balance_ledger_due_date_idx
  ON renter_balance_ledger (due_date)
  WHERE due_date IS NOT NULL;

COMMENT ON COLUMN renter_balance_ledger.due_date IS
  'Optional date when this charge is due. Used for renter reminders and overdue tracking (Phase 5+).';
