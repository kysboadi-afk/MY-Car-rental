-- supabase/migrations/0178_staging_validation.sql
-- Staging validation for migrations 0175, 0176, and 0177.
--
-- PURPOSE:
--   Confirms that each Wave A migration left the expected schema objects on the
--   target database.  Run this after applying 0175 → 0176 → 0177 (in that order)
--   to verify the full sequence completed without silent failures.
--
-- HOW TO USE:
--   psql <connection> -f 0178_staging_validation.sql
--
--   A successful run prints one NOTICE per validation point, ending with:
--     "VALIDATION COMPLETE: Wave A staging checks passed."
--   Any missing object raises a RAISE EXCEPTION that aborts the script with a
--   clear error message identifying which migration step is incomplete.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   All checks are wrapped in a single DO block; the exception rolls back the
--   implicit savepoint so the rest of the connection session is unaffected.

DO $$
DECLARE
  -- ── 0175 expected objects ──────────────────────────────────────────────────
  v_table_organizations         boolean;
  v_table_organization_users    boolean;
  v_table_organization_settings boolean;
  v_table_operator_leads        boolean;
  v_idx_org_slug                boolean;
  v_idx_org_status              boolean;
  v_idx_ou_user_id              boolean;
  v_trigger_org_updated_at      boolean;
  v_trigger_ou_updated_at       boolean;

  -- ── 0176 expected objects ──────────────────────────────────────────────────
  v_col_bookings_org_id         boolean;
  v_col_customers_org_id        boolean;
  v_fk_bookings_org             boolean;
  v_fk_customers_org            boolean;
  v_idx_bookings_org            boolean;
  v_idx_customers_org           boolean;
  v_trigger_bookings_default    boolean;
  v_trigger_customers_default   boolean;
  v_fn_ensure_default_org       boolean;
  v_fn_assign_default_org       boolean;
  v_default_org_row             boolean;

  -- ── 0177 expected objects ──────────────────────────────────────────────────
  v_col_revenue_org_id          boolean;
  v_col_ledger_org_id           boolean;
  v_col_payment_plans_org_id    boolean;
  v_col_installments_org_id     boolean;
  v_fk_revenue_org              boolean;
  v_fk_ledger_org               boolean;
  v_fk_payment_plans_org        boolean;
  v_fk_installments_org         boolean;
  v_idx_revenue_org             boolean;
  v_idx_ledger_org              boolean;
  v_idx_payment_plans_org       boolean;
  v_idx_installments_org        boolean;
  v_trigger_revenue_default     boolean;
  v_trigger_ledger_default      boolean;
  v_trigger_payment_plans_default    boolean;
  v_trigger_installments_default boolean;
BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0175: organizations_foundation
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organizations'
  ) INTO v_table_organizations;
  IF NOT v_table_organizations THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.organizations does not exist. Migration 0175 has not been applied.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.organizations exists.';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_users'
  ) INTO v_table_organization_users;
  IF NOT v_table_organization_users THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.organization_users does not exist.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.organization_users exists.';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_settings'
  ) INTO v_table_organization_settings;
  IF NOT v_table_organization_settings THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.organization_settings does not exist.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.organization_settings exists.';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'operator_leads'
  ) INTO v_table_operator_leads;
  IF NOT v_table_operator_leads THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.operator_leads does not exist.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.operator_leads exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_organizations_slug'
  ) INTO v_idx_org_slug;
  IF NOT v_idx_org_slug THEN
    RAISE EXCEPTION '[0175 FAIL] Index idx_organizations_slug is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Index idx_organizations_slug exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_organizations_status'
  ) INTO v_idx_org_status;
  IF NOT v_idx_org_status THEN
    RAISE EXCEPTION '[0175 FAIL] Index idx_organizations_status is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Index idx_organizations_status exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_org_users_user_id'
  ) INTO v_idx_ou_user_id;
  IF NOT v_idx_ou_user_id THEN
    RAISE EXCEPTION '[0175 FAIL] Index idx_org_users_user_id is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Index idx_org_users_user_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organizations_updated_at'
  ) INTO v_trigger_org_updated_at;
  IF NOT v_trigger_org_updated_at THEN
    RAISE EXCEPTION '[0175 FAIL] Trigger set_organizations_updated_at is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Trigger set_organizations_updated_at exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organization_users_updated_at'
  ) INTO v_trigger_ou_updated_at;
  IF NOT v_trigger_ou_updated_at THEN
    RAISE EXCEPTION '[0175 FAIL] Trigger set_organization_users_updated_at is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Trigger set_organization_users_updated_at exists.';

  RAISE NOTICE '[0175 PASS] Migration 0175 (organizations_foundation) validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0176: bookings_customers_tenant_foundation
  -- ══════════════════════════════════════════════════════════════════════════

  -- Verify ensure_default_organization() function exists
  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'ensure_default_organization'
  ) INTO v_fn_ensure_default_org;
  IF NOT v_fn_ensure_default_org THEN
    RAISE EXCEPTION '[0176 FAIL] Function public.ensure_default_organization() is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Function public.ensure_default_organization() exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'assign_default_organization_id'
  ) INTO v_fn_assign_default_org;
  IF NOT v_fn_assign_default_org THEN
    RAISE EXCEPTION '[0176 FAIL] Function public.assign_default_organization_id() is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Function public.assign_default_organization_id() exists.';

  -- Verify default org row was seeded
  SELECT EXISTS (
    SELECT 1 FROM public.organizations WHERE slug = 'sly-rides-default' AND status = 'active'
  ) INTO v_default_org_row;
  IF NOT v_default_org_row THEN
    RAISE EXCEPTION '[0176 FAIL] Default organization row (slug=sly-rides-default, status=active) is missing. Backfill did not run.';
  END IF;
  RAISE NOTICE '[0176 OK] Default organization row (slug=sly-rides-default) exists and is active.';

  -- bookings.organization_id column
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'organization_id'
  ) INTO v_col_bookings_org_id;
  IF NOT v_col_bookings_org_id THEN
    RAISE EXCEPTION '[0176 FAIL] Column bookings.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0176 OK] Column bookings.organization_id exists.';

  -- customers.organization_id column
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'organization_id'
  ) INTO v_col_customers_org_id;
  IF NOT v_col_customers_org_id THEN
    RAISE EXCEPTION '[0176 FAIL] Column customers.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0176 OK] Column customers.organization_id exists.';

  -- bookings FK
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bookings_organization_id_fkey'
  ) INTO v_fk_bookings_org;
  IF NOT v_fk_bookings_org THEN
    RAISE EXCEPTION '[0176 FAIL] FK constraint bookings_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] FK constraint bookings_organization_id_fkey exists.';

  -- customers FK
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_organization_id_fkey'
  ) INTO v_fk_customers_org;
  IF NOT v_fk_customers_org THEN
    RAISE EXCEPTION '[0176 FAIL] FK constraint customers_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] FK constraint customers_organization_id_fkey exists.';

  -- bookings index
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'bookings_organization_id_idx'
  ) INTO v_idx_bookings_org;
  IF NOT v_idx_bookings_org THEN
    RAISE EXCEPTION '[0176 FAIL] Index bookings_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Index bookings_organization_id_idx exists.';

  -- customers index
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'customers_organization_id_idx'
  ) INTO v_idx_customers_org;
  IF NOT v_idx_customers_org THEN
    RAISE EXCEPTION '[0176 FAIL] Index customers_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Index customers_organization_id_idx exists.';

  -- bookings trigger
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_bookings_assign_default_organization_id'
  ) INTO v_trigger_bookings_default;
  IF NOT v_trigger_bookings_default THEN
    RAISE EXCEPTION '[0176 FAIL] Trigger trg_bookings_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Trigger trg_bookings_assign_default_organization_id exists.';

  -- customers trigger
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_customers_assign_default_organization_id'
  ) INTO v_trigger_customers_default;
  IF NOT v_trigger_customers_default THEN
    RAISE EXCEPTION '[0176 FAIL] Trigger trg_customers_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Trigger trg_customers_assign_default_organization_id exists.';

  RAISE NOTICE '[0176 PASS] Migration 0176 (bookings_customers_tenant_foundation) validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0177: financial_tenant_foundation
  -- ══════════════════════════════════════════════════════════════════════════

  -- revenue_records
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'revenue_records' AND column_name = 'organization_id'
  ) INTO v_col_revenue_org_id;
  IF NOT v_col_revenue_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column revenue_records.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column revenue_records.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'revenue_records_organization_id_fkey'
  ) INTO v_fk_revenue_org;
  IF NOT v_fk_revenue_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint revenue_records_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint revenue_records_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'revenue_records_organization_id_idx'
  ) INTO v_idx_revenue_org;
  IF NOT v_idx_revenue_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index revenue_records_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index revenue_records_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_revenue_records_assign_default_organization_id'
  ) INTO v_trigger_revenue_default;
  IF NOT v_trigger_revenue_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_revenue_records_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_revenue_records_assign_default_organization_id exists.';

  -- renter_balance_ledger
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'renter_balance_ledger' AND column_name = 'organization_id'
  ) INTO v_col_ledger_org_id;
  IF NOT v_col_ledger_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column renter_balance_ledger.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column renter_balance_ledger.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'renter_balance_ledger_organization_id_fkey'
  ) INTO v_fk_ledger_org;
  IF NOT v_fk_ledger_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint renter_balance_ledger_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint renter_balance_ledger_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'renter_balance_ledger_organization_id_idx'
  ) INTO v_idx_ledger_org;
  IF NOT v_idx_ledger_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index renter_balance_ledger_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index renter_balance_ledger_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_renter_balance_ledger_assign_default_organization_id'
  ) INTO v_trigger_ledger_default;
  IF NOT v_trigger_ledger_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_renter_balance_ledger_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_renter_balance_ledger_assign_default_organization_id exists.';

  -- payment_plans
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_plans' AND column_name = 'organization_id'
  ) INTO v_col_payment_plans_org_id;
  IF NOT v_col_payment_plans_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column payment_plans.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column payment_plans.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_plans_organization_id_fkey'
  ) INTO v_fk_payment_plans_org;
  IF NOT v_fk_payment_plans_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint payment_plans_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint payment_plans_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'payment_plans_organization_id_idx'
  ) INTO v_idx_payment_plans_org;
  IF NOT v_idx_payment_plans_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index payment_plans_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index payment_plans_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_payment_plans_assign_default_organization_id'
  ) INTO v_trigger_payment_plans_default;
  IF NOT v_trigger_payment_plans_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_payment_plans_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_payment_plans_assign_default_organization_id exists.';

  -- payment_plan_installments
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_plan_installments' AND column_name = 'organization_id'
  ) INTO v_col_installments_org_id;
  IF NOT v_col_installments_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column payment_plan_installments.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column payment_plan_installments.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_plan_installments_organization_id_fkey'
  ) INTO v_fk_installments_org;
  IF NOT v_fk_installments_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint payment_plan_installments_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint payment_plan_installments_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'payment_plan_installments_organization_id_idx'
  ) INTO v_idx_installments_org;
  IF NOT v_idx_installments_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index payment_plan_installments_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index payment_plan_installments_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_payment_plan_installments_assign_default_organization_id'
  ) INTO v_trigger_installments_default;
  IF NOT v_trigger_installments_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_payment_plan_installments_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_payment_plan_installments_assign_default_organization_id exists.';

  RAISE NOTICE '[0177 PASS] Migration 0177 (financial_tenant_foundation) validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- ALL CHECKS PASSED
  -- ══════════════════════════════════════════════════════════════════════════
  RAISE NOTICE 'VALIDATION COMPLETE: Wave A staging checks passed. Safe to proceed to backfill audit.';

END $$;
