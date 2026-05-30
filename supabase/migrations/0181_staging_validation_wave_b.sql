-- supabase/migrations/0181_staging_validation_wave_b.sql
-- Staging validation for migration 0180 (financial_tenant_wave_b).
--
-- PURPOSE:
--   Confirms that the Wave B migration left the expected schema objects on the
--   target database.  Run this after applying 0175 → 0176 → 0177 → 0178 → 0179
--   → 0180 (in that order) to verify the full sequence completed without silent
--   failures.
--
-- Tables validated:
--   charges, tickets, booking_extensions, customer_ledger
--
-- HOW TO USE:
--   psql <connection> -f 0181_staging_validation_wave_b.sql
--
--   A successful run prints one NOTICE per validation point, ending with:
--     "VALIDATION COMPLETE: Wave B staging checks passed."
--   Any missing object raises a RAISE EXCEPTION that aborts the script with a
--   clear error message identifying which table or constraint is incomplete.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   All checks are wrapped in a single DO block; the exception rolls back the
--   implicit savepoint so the rest of the connection session is unaffected.

DO $$
DECLARE
  -- ── charges ────────────────────────────────────────────────────────────────
  v_col_charges_org_id          boolean;
  v_fk_charges_org              boolean;
  v_idx_charges_org             boolean;
  v_trigger_charges_default     boolean;

  -- ── tickets ────────────────────────────────────────────────────────────────
  v_col_tickets_org_id          boolean;
  v_fk_tickets_org              boolean;
  v_idx_tickets_org             boolean;
  v_trigger_tickets_default     boolean;

  -- ── booking_extensions ─────────────────────────────────────────────────────
  v_col_bext_org_id             boolean;
  v_fk_bext_org                 boolean;
  v_idx_bext_org                boolean;
  v_trigger_bext_default        boolean;

  -- ── customer_ledger ────────────────────────────────────────────────────────
  v_col_cl_org_id               boolean;
  v_fk_cl_org                   boolean;
  v_idx_cl_org                  boolean;
  v_trigger_cl_default          boolean;

  -- ── shared helpers ─────────────────────────────────────────────────────────
  v_fn_ensure_default_org       boolean;
  v_fn_assign_default_org       boolean;
  v_default_org_row             boolean;
BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- PREREQUISITE: shared helper functions and default org row
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'ensure_default_organization'
  ) INTO v_fn_ensure_default_org;
  IF NOT v_fn_ensure_default_org THEN
    RAISE EXCEPTION '[0180 PREREQ FAIL] Function public.ensure_default_organization() is missing. Apply Wave A migrations first.';
  END IF;
  RAISE NOTICE '[PREREQ OK] Function public.ensure_default_organization() exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'assign_default_organization_id'
  ) INTO v_fn_assign_default_org;
  IF NOT v_fn_assign_default_org THEN
    RAISE EXCEPTION '[0180 PREREQ FAIL] Function public.assign_default_organization_id() is missing. Apply Wave A migrations first.';
  END IF;
  RAISE NOTICE '[PREREQ OK] Function public.assign_default_organization_id() exists.';

  SELECT EXISTS (
    SELECT 1 FROM public.organizations WHERE slug = 'sly-rides-default' AND status = 'active'
  ) INTO v_default_org_row;
  IF NOT v_default_org_row THEN
    RAISE EXCEPTION '[0180 PREREQ FAIL] Default organization row (slug=sly-rides-default) is missing. Apply migration 0176 first.';
  END IF;
  RAISE NOTICE '[PREREQ OK] Default organization row (slug=sly-rides-default) exists and is active.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: charges
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'charges' AND column_name = 'organization_id'
  ) INTO v_col_charges_org_id;
  IF NOT v_col_charges_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column charges.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column charges.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charges_organization_id_fkey'
  ) INTO v_fk_charges_org;
  IF NOT v_fk_charges_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint charges_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint charges_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'charges_organization_id_idx'
  ) INTO v_idx_charges_org;
  IF NOT v_idx_charges_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index charges_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index charges_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_charges_assign_default_organization_id'
  ) INTO v_trigger_charges_default;
  IF NOT v_trigger_charges_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_charges_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_charges_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] charges scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: tickets
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'organization_id'
  ) INTO v_col_tickets_org_id;
  IF NOT v_col_tickets_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column tickets.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column tickets.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tickets_organization_id_fkey'
  ) INTO v_fk_tickets_org;
  IF NOT v_fk_tickets_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint tickets_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint tickets_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'tickets_organization_id_idx'
  ) INTO v_idx_tickets_org;
  IF NOT v_idx_tickets_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index tickets_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index tickets_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_tickets_assign_default_organization_id'
  ) INTO v_trigger_tickets_default;
  IF NOT v_trigger_tickets_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_tickets_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_tickets_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] tickets scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: booking_extensions
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'booking_extensions' AND column_name = 'organization_id'
  ) INTO v_col_bext_org_id;
  IF NOT v_col_bext_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column booking_extensions.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column booking_extensions.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'booking_extensions_organization_id_fkey'
  ) INTO v_fk_bext_org;
  IF NOT v_fk_bext_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint booking_extensions_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint booking_extensions_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'booking_extensions_organization_id_idx'
  ) INTO v_idx_bext_org;
  IF NOT v_idx_bext_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index booking_extensions_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index booking_extensions_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_booking_extensions_assign_default_organization_id'
  ) INTO v_trigger_bext_default;
  IF NOT v_trigger_bext_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_booking_extensions_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_booking_extensions_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] booking_extensions scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: customer_ledger
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customer_ledger' AND column_name = 'organization_id'
  ) INTO v_col_cl_org_id;
  IF NOT v_col_cl_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column customer_ledger.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column customer_ledger.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_ledger_organization_id_fkey'
  ) INTO v_fk_cl_org;
  IF NOT v_fk_cl_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint customer_ledger_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint customer_ledger_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'customer_ledger_organization_id_idx'
  ) INTO v_idx_cl_org;
  IF NOT v_idx_cl_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index customer_ledger_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index customer_ledger_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_customer_ledger_assign_default_organization_id'
  ) INTO v_trigger_cl_default;
  IF NOT v_trigger_cl_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_customer_ledger_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_customer_ledger_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] customer_ledger scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- ALL CHECKS PASSED
  -- ══════════════════════════════════════════════════════════════════════════
  RAISE NOTICE 'VALIDATION COMPLETE: Wave B staging checks passed. Safe to proceed to Wave B backfill audit (0182).';

END $$;
