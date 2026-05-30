-- supabase/migrations/0180_operator_leads_validation.sql
-- Read-only validation for operator lead ingestion.
--
-- HOW TO USE:
--   psql <connection> -f 0180_operator_leads_validation.sql

DO $$
DECLARE
  v_table_exists boolean;
  v_col_first_name text;
  v_col_last_name text;
  v_col_email text;
  v_col_phone text;
  v_col_fleet_size text;
  v_col_source text;
  v_col_notes text;
  v_rls_enabled boolean;
  v_rls_forced boolean;
  v_policy_count integer;
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

  SELECT data_type INTO v_col_first_name
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'operator_leads' AND column_name = 'first_name';
  IF v_col_first_name <> 'text' THEN
    RAISE EXCEPTION '[operator_leads FAIL] Column first_name missing or wrong type (%).', COALESCE(v_col_first_name, 'missing');
  END IF;

  SELECT data_type INTO v_col_last_name
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'operator_leads' AND column_name = 'last_name';
  IF v_col_last_name <> 'text' THEN
    RAISE EXCEPTION '[operator_leads FAIL] Column last_name missing or wrong type (%).', COALESCE(v_col_last_name, 'missing');
  END IF;

  SELECT data_type INTO v_col_email
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'operator_leads' AND column_name = 'email';
  IF v_col_email <> 'text' THEN
    RAISE EXCEPTION '[operator_leads FAIL] Column email missing or wrong type (%).', COALESCE(v_col_email, 'missing');
  END IF;

  SELECT data_type INTO v_col_phone
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'operator_leads' AND column_name = 'phone';
  IF v_col_phone <> 'text' THEN
    RAISE EXCEPTION '[operator_leads FAIL] Column phone missing or wrong type (%).', COALESCE(v_col_phone, 'missing');
  END IF;

  SELECT data_type INTO v_col_fleet_size
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'operator_leads' AND column_name = 'fleet_size';
  IF v_col_fleet_size <> 'text' THEN
    RAISE EXCEPTION '[operator_leads FAIL] Column fleet_size missing or wrong type (%).', COALESCE(v_col_fleet_size, 'missing');
  END IF;

  SELECT data_type INTO v_col_source
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'operator_leads' AND column_name = 'source';
  IF v_col_source <> 'text' THEN
    RAISE EXCEPTION '[operator_leads FAIL] Column source missing or wrong type (%).', COALESCE(v_col_source, 'missing');
  END IF;

  SELECT data_type INTO v_col_notes
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'operator_leads' AND column_name = 'notes';
  IF v_col_notes <> 'text' THEN
    RAISE EXCEPTION '[operator_leads FAIL] Column notes missing or wrong type (%).', COALESCE(v_col_notes, 'missing');
  END IF;

  RAISE NOTICE '[operator_leads OK] Insert payload columns match api/operator-leads.js.';

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'operator_leads';

  SELECT COUNT(*)
    INTO v_policy_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'operator_leads';

  RAISE NOTICE '[operator_leads INFO] RLS enabled=% forced=% policies=%',
    COALESCE(v_rls_enabled, false),
    COALESCE(v_rls_forced, false),
    COALESCE(v_policy_count, 0);

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
