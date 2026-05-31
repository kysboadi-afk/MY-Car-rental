-- supabase/migrations/0186_website_services_upsell_phase_b.sql
-- Phase B (Option B): post-conversion website services onboarding lifecycle.

BEGIN;

CREATE TABLE IF NOT EXISTS public.organization_service_upsells (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  service_key           TEXT        NOT NULL,
  interest_status       TEXT        NOT NULL DEFAULT 'not_asked',
  acceptance_status     TEXT        NOT NULL DEFAULT 'not_offered',
  completion_status     TEXT        NOT NULL DEFAULT 'not_started',
  website_status        TEXT        NOT NULL DEFAULT 'none',
  selected_package_code TEXT,
  package_snapshot      JSONB,
  offered_at            TIMESTAMPTZ,
  accepted_at           TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  updated_by            TEXT,
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, service_key),
  CHECK (interest_status IN ('not_asked', 'interested', 'not_interested')),
  CHECK (acceptance_status IN ('not_offered', 'offered', 'accepted', 'declined')),
  CHECK (completion_status IN ('not_started', 'in_progress', 'completed')),
  CHECK (website_status IN ('none', 'hosted_booking_page', 'custom_website', 'external_website')),
  CHECK (accepted_at IS NULL OR acceptance_status = 'accepted'),
  CHECK (completed_at IS NULL OR completion_status = 'completed')
);

CREATE INDEX IF NOT EXISTS idx_org_service_upsells_service_key
  ON public.organization_service_upsells (service_key);
CREATE INDEX IF NOT EXISTS idx_org_service_upsells_interest_status
  ON public.organization_service_upsells (interest_status);
CREATE INDEX IF NOT EXISTS idx_org_service_upsells_acceptance_status
  ON public.organization_service_upsells (acceptance_status);
CREATE INDEX IF NOT EXISTS idx_org_service_upsells_completion_status
  ON public.organization_service_upsells (completion_status);
CREATE INDEX IF NOT EXISTS idx_org_service_upsells_website_status
  ON public.organization_service_upsells (website_status);
CREATE INDEX IF NOT EXISTS idx_org_service_upsells_org_service
  ON public.organization_service_upsells (organization_id, service_key);

CREATE TABLE IF NOT EXISTS public.service_package_catalog (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key      TEXT        NOT NULL,
  package_code     TEXT        NOT NULL,
  package_name     TEXT        NOT NULL,
  deliverables     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  pricing_metadata JSONB       NOT NULL DEFAULT '{}'::jsonb,
  billing_metadata JSONB       NOT NULL DEFAULT '{}'::jsonb,
  version          INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_key, package_code, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_package_catalog_active_code
  ON public.service_package_catalog (service_key, package_code)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_service_package_catalog_service_active
  ON public.service_package_catalog (service_key, is_active);

INSERT INTO public.service_package_catalog (
  service_key,
  package_code,
  package_name,
  deliverables,
  pricing_metadata,
  billing_metadata,
  version,
  is_active,
  metadata
)
VALUES
  (
    'website_services',
    'website_starter',
    'Website Starter',
    '["Hosted booking landing page","Branding setup","Lead capture form"]'::jsonb,
    '{"currency":"USD","amount_cents":14900,"billing_model":"one_time"}'::jsonb,
    '{"payment_terms":"due_on_acceptance"}'::jsonb,
    1,
    true,
    '{"tier":"starter"}'::jsonb
  ),
  (
    'website_services',
    'website_growth',
    'Website Growth',
    '["Custom multipage website","Booking funnel optimization","Analytics setup"]'::jsonb,
    '{"currency":"USD","amount_cents":39900,"billing_model":"one_time"}'::jsonb,
    '{"payment_terms":"50_50_milestone"}'::jsonb,
    1,
    true,
    '{"tier":"growth"}'::jsonb
  )
ON CONFLICT (service_key, package_code, version) DO NOTHING;

INSERT INTO public.organization_service_upsells (
  organization_id,
  service_key,
  interest_status,
  acceptance_status,
  completion_status,
  website_status,
  metadata
)
SELECT DISTINCT
  ol.organization_id,
  'website_services',
  'not_asked',
  'not_offered',
  'not_started',
  'none',
  jsonb_build_object(
    'seed_source', 'operator_lead_backfill',
    'seeded_at', NOW()
  )
FROM public.operator_leads ol
WHERE ol.organization_id IS NOT NULL
  AND (ol.status = 'active_operator' OR ol.conversion_status = 'succeeded')
ON CONFLICT (organization_id, service_key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'set_updated_at'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger
       WHERE tgname = 'set_org_service_upsells_updated_at'
    ) THEN
      CREATE TRIGGER set_org_service_upsells_updated_at
        BEFORE UPDATE ON public.organization_service_upsells
        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger
       WHERE tgname = 'set_service_package_catalog_updated_at'
    ) THEN
      CREATE TRIGGER set_service_package_catalog_updated_at
        BEFORE UPDATE ON public.service_package_catalog
        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    END IF;
  END IF;
END $$;

ALTER TABLE public.organization_service_upsells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_package_catalog ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.service_package_catalog TO anon;
GRANT ALL ON TABLE public.organization_service_upsells TO service_role;
GRANT ALL ON TABLE public.service_package_catalog TO service_role;

DROP POLICY IF EXISTS organization_service_upsells_service_role_all ON public.organization_service_upsells;
CREATE POLICY organization_service_upsells_service_role_all
  ON public.organization_service_upsells
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_package_catalog_service_role_all ON public.service_package_catalog;
CREATE POLICY service_package_catalog_service_role_all
  ON public.service_package_catalog
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_package_catalog_anon_read ON public.service_package_catalog;
CREATE POLICY service_package_catalog_anon_read
  ON public.service_package_catalog
  FOR SELECT
  TO anon
  USING (is_active = true);

NOTIFY pgrst, 'reload schema';

COMMIT;
