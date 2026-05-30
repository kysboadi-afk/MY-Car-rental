-- supabase/migrations/0180_operator_leads_validation.sql
-- Read-only validation for operator lead ingestion.
--
-- HOW TO USE:
--   psql <connection> -f 0180_operator_leads_validation.sql

DO $$
DECLARE
  v_table_exists boolean;
  v_rls_enabled boolean;
  v_schema_migrations_exists boolean;
  v_has_0175_record boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
  ) INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE EXCEPTION '[operator_leads FAIL] Table public.operator_leads does not exist.';
  END IF;
  RAISE NOTICE '[operator_leads OK] Table public.operator_leads exists.';

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'first_name'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] first_name is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] first_name must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'last_name'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] last_name is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] last_name must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'email'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] email is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] email must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'phone'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] phone is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] phone must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'fleet_size'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] fleet_size is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] fleet_size must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'source'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] source is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] source must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'notes'
       AND data_type = 'text'
  ) THEN
    RAISE NOTICE '[operator_leads OK] notes is text.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] notes must be text.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'status'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] status is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] status must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'onboarding_progress'
       AND data_type = 'jsonb'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] onboarding_progress is jsonb NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] onboarding_progress must be jsonb NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'created_at'
       AND data_type = 'timestamp with time zone'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] created_at is timestamptz NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] created_at must be timestamptz NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp with time zone'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] updated_at is timestamptz NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] updated_at must be timestamptz NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'operator_leads'
       AND c.conname = 'operator_leads_status_check'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%new_lead%'
       AND pg_get_constraintdef(c.oid) ILIKE '%contacted%'
       AND pg_get_constraintdef(c.oid) ILIKE '%demo_scheduled%'
       AND pg_get_constraintdef(c.oid) ILIKE '%onboarding%'
       AND pg_get_constraintdef(c.oid) ILIKE '%active_operator%'
       AND pg_get_constraintdef(c.oid) ILIKE '%rejected%'
  ) THEN
    RAISE NOTICE '[operator_leads OK] Named status check constraint exists and includes expected states.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] Missing or invalid operator_leads_status_check constraint.';
  END IF;

  SELECT c.relrowsecurity
    INTO v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'operator_leads';

  IF COALESCE(v_rls_enabled, false) THEN
    RAISE NOTICE '[operator_leads OK] RLS is enabled.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] RLS must be enabled on public.operator_leads.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'operator_leads'
       AND policyname = 'operator_leads_anon_insert'
       AND cmd = 'INSERT'
       AND roles @> ARRAY['anon']::name[]
  ) THEN
    RAISE NOTICE '[operator_leads OK] Policy operator_leads_anon_insert exists.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] Missing policy operator_leads_anon_insert for anon inserts.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'operator_leads'
       AND policyname = 'operator_leads_service_role_all'
       AND cmd = 'ALL'
       AND roles @> ARRAY['service_role']::name[]
  ) THEN
    RAISE NOTICE '[operator_leads OK] Policy operator_leads_service_role_all exists.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] Missing policy operator_leads_service_role_all for service_role.';
  END IF;

  IF has_table_privilege('anon', 'public.operator_leads', 'INSERT') THEN
    RAISE NOTICE '[operator_leads OK] anon has INSERT grant.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] anon must have INSERT grant on public.operator_leads.';
  END IF;

  IF has_table_privilege('service_role', 'public.operator_leads', 'INSERT,SELECT,UPDATE,DELETE') THEN
    RAISE NOTICE '[operator_leads OK] service_role has ALL table grants.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] service_role must have ALL table grants on public.operator_leads.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'supabase_migrations'
       AND table_name = 'schema_migrations'
  ) INTO v_schema_migrations_exists;

  IF v_schema_migrations_exists THEN
    SELECT EXISTS (
      SELECT 1
        FROM supabase_migrations.schema_migrations
       WHERE version = '0175'
    ) INTO v_has_0175_record;

    IF v_has_0175_record THEN
      RAISE NOTICE '[operator_leads OK] supabase_migrations records version 0175.';
    ELSE
      RAISE NOTICE '[operator_leads WARN] supabase_migrations does not record version 0175.';
    END IF;
  ELSE
    RAISE NOTICE '[operator_leads WARN] supabase_migrations.schema_migrations table not available for history verification.';
  END IF;

  RAISE NOTICE '[operator_leads PASS] Validation complete.';
END $$;
