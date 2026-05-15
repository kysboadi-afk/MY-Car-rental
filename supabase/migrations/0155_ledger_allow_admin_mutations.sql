-- Migration 0155: Allow admin DELETE and UPDATE on renter_balance_ledger
--
-- The append-only triggers (no_delete, no_update) were added in migration 0148
-- to guard ledger integrity. The admin Balance Ledger page exposes Delete and
-- Edit actions that route through the admin-only renter-balance-ledger API,
-- which already enforces authorization and field-level guards. Keeping the DB
-- triggers makes those UI actions non-functional, so we drop them here.

DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_delete ON renter_balance_ledger;
DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_update ON renter_balance_ledger;
DROP FUNCTION IF EXISTS fn_prevent_renter_balance_ledger_mutation();
