-- Migration 0052: fix revenue_records_effective view
--
-- Problem: The revenue_records_effective view was created with additional
-- filters beyond sync_excluded that excluded valid Stripe-backed rows.
-- This caused the Revenue page to under-report (showing ~$2,008 / 6 records)
-- while the Dashboard correctly showed ~$2,850 by querying the base table
-- with only sync_excluded = false.
--
-- Fix: Redefine revenue_records_effective to expose ALL rows from
-- revenue_records where sync_excluded = false.  This is the only filter that
-- should be applied at the view level:
--   • sync_excluded = true  → admin soft-deleted the record; hide it
--   • everything else       → include (Stripe-backed, manually created, etc.)
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW revenue_records_effective AS
SELECT *
FROM   revenue_records
WHERE  sync_excluded = false;
