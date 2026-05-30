-- supabase/migrations/0179_operator_leads_api_alignment.sql
-- Align public.operator_leads with the payload written by api/operator-leads.js
-- and notify PostgREST so /api/operator-leads can write immediately after deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS public.operator_leads (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name          TEXT        NOT NULL,
  last_name           TEXT        NOT NULL,
  email               TEXT        NOT NULL,
  phone               TEXT,
  fleet_size          TEXT,
  source              TEXT,
  status              TEXT        NOT NULL DEFAULT 'new_lead'
                        CHECK (status IN (
                          'new_lead',
                          'contacted',
                          'demo_scheduled',
                          'onboarding',
                          'active_operator',
                          'rejected'
                        )),
  notes               TEXT,
  onboarding_progress JSONB       NOT NULL DEFAULT '{}'::jsonb,
  stripe_status       TEXT,
  organization_id     UUID,
  demo_scheduled_at   TIMESTAMPTZ,
  contacted_at        TIMESTAMPTZ,
  activated_at        TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.operator_leads
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS fleet_size TEXT,
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_progress JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS stripe_status TEXT,
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS demo_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DO $$
DECLARE
  v_has_name_column boolean;
  v_has_onboarding_notes_column boolean;
  v_fleet_size_type text;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'operator_leads'
      AND column_name = 'name'
  ) INTO v_has_name_column;

  IF v_has_name_column THEN
    EXECUTE $sql$
      UPDATE public.operator_leads
         SET first_name = COALESCE(
               NULLIF(first_name, ''),
               NULLIF(split_part(BTRIM(name), ' ', 1), ''),
               'Lead'
             ),
             last_name = COALESCE(
               NULLIF(last_name, ''),
               NULLIF(BTRIM(regexp_replace(BTRIM(name), '^\S+\s*', '')), ''),
               'Lead'
             )
       WHERE COALESCE(name, '') <> ''
         AND (
           COALESCE(first_name, '') = ''
           OR COALESCE(last_name, '') = ''
         )
    $sql$;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'operator_leads'
      AND column_name = 'onboarding_notes'
  ) INTO v_has_onboarding_notes_column;

  IF v_has_onboarding_notes_column THEN
    EXECUTE $sql$
      UPDATE public.operator_leads
         SET notes = onboarding_notes
       WHERE COALESCE(notes, '') = ''
         AND COALESCE(onboarding_notes, '') <> ''
    $sql$;
  END IF;

  SELECT data_type
    INTO v_fleet_size_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'operator_leads'
     AND column_name = 'fleet_size';

  IF v_fleet_size_type = 'integer' THEN
    ALTER TABLE public.operator_leads
      ALTER COLUMN fleet_size TYPE TEXT
      USING CASE
        WHEN fleet_size IS NULL THEN NULL
        ELSE fleet_size::text
      END;
  END IF;
END $$;

ALTER TABLE public.operator_leads
  ALTER COLUMN status SET DEFAULT 'new_lead',
  ALTER COLUMN onboarding_progress SET DEFAULT '{}'::jsonb,
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET DEFAULT NOW();

UPDATE public.operator_leads
   SET status = 'new_lead'
 WHERE status IS NULL;

UPDATE public.operator_leads
   SET onboarding_progress = '{}'::jsonb
 WHERE onboarding_progress IS NULL;

UPDATE public.operator_leads
   SET created_at = NOW()
 WHERE created_at IS NULL;

UPDATE public.operator_leads
   SET updated_at = NOW()
 WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_leads_status
  ON public.operator_leads (status);

CREATE INDEX IF NOT EXISTS idx_operator_leads_email
  ON public.operator_leads (email);

CREATE INDEX IF NOT EXISTS idx_operator_leads_created
  ON public.operator_leads (created_at DESC);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'organizations'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'operator_leads_organization_id_fkey'
  ) THEN
    ALTER TABLE public.operator_leads
      ADD CONSTRAINT operator_leads_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'set_operator_leads_updated_at'
  ) THEN
    CREATE TRIGGER set_operator_leads_updated_at
      BEFORE UPDATE ON public.operator_leads
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
