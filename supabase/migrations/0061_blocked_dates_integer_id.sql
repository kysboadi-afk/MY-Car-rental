-- Ensure blocked_dates uses an integer id primary key so admin delete-by-id
-- operations can use numeric IDs consistently.

DO $$
DECLARE
  v_id_type text;
  v_pk_name text;
BEGIN
  SELECT data_type
    INTO v_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'blocked_dates'
    AND column_name = 'id';

  IF v_id_type IS NULL THEN
    ALTER TABLE public.blocked_dates
      ADD COLUMN id SERIAL;
    ALTER TABLE public.blocked_dates
      ADD CONSTRAINT blocked_dates_pkey PRIMARY KEY (id);
    RETURN;
  END IF;

  IF v_id_type = 'integer' THEN
    RETURN;
  END IF;

  SELECT c.conname
    INTO v_pk_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE c.contype = 'p'
    AND n.nspname = 'public'
    AND t.relname = 'blocked_dates'
  LIMIT 1;

  IF v_pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.blocked_dates DROP CONSTRAINT %I', v_pk_name);
  END IF;

  ALTER TABLE public.blocked_dates RENAME COLUMN id TO legacy_uuid_id;
  ALTER TABLE public.blocked_dates ADD COLUMN id SERIAL;
  ALTER TABLE public.blocked_dates ADD CONSTRAINT blocked_dates_pkey PRIMARY KEY (id);
END $$;
