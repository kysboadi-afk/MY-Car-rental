-- =============================================================================
-- Migration 0123: replace bare NOT NULL on revenue_records.booking_ref with
--                 a precise CHECK constraint
-- =============================================================================
--
-- Background
-- ----------
-- Migration 0122 added revenue_records.booking_ref as NULLABLE (correct intent:
-- orphan records with is_orphan = true legitimately have booking_ref = NULL).
--
-- The live database, however, has a bare NOT NULL constraint on this column
-- that was applied outside the migration history.  This causes every call to
-- createOrphanRevenueRecord to fail with:
--
--   null value in column "booking_ref" of relation "revenue_records"
--   violates not-null constraint  (code 23502)
--
-- Fix (permanent)
-- ---------------
-- Replace the bare NOT NULL with a CHECK constraint that encodes the exact
-- business rule:
--
--   Non-orphan rows MUST have a booking_ref.
--   Orphan rows (is_orphan = true) are explicitly exempt.
--
--   CHECK (is_orphan = true OR booking_ref IS NOT NULL)
--
-- This is a schema-level, self-documenting invariant — it can never drift
-- silently the way a bare NOT NULL does.
--
-- Steps
-- -----
-- 1. Drop the NOT NULL constraint (ALTER COLUMN … DROP NOT NULL is a no-op if
--    the column is already nullable — safe to re-run).
-- 2. Add the CHECK constraint (IF NOT EXISTS guard makes it idempotent).
-- 3. Update the column comment to document the rule.
--
-- Safe to re-run: DROP NOT NULL is idempotent; ADD CONSTRAINT uses IF NOT EXISTS.
-- =============================================================================

-- ── 1. Drop bare NOT NULL (makes column nullable for orphan rows) ─────────────

ALTER TABLE revenue_records
  ALTER COLUMN booking_ref DROP NOT NULL;

-- ── 2. Add precise CHECK constraint ──────────────────────────────────────────

ALTER TABLE revenue_records
  ADD CONSTRAINT revenue_records_booking_ref_required
    CHECK (is_orphan = true OR booking_ref IS NOT NULL);

-- ── 3. Update column comment ──────────────────────────────────────────────────

COMMENT ON COLUMN revenue_records.booking_ref IS
  'FK to bookings.booking_ref — mirrors booking_id for joined queries. '
  'NULL is permitted ONLY when is_orphan = true '
  '(enforced by revenue_records_booking_ref_required CHECK constraint). '
  'Non-orphan rows must always supply a valid booking_ref.';
