-- Migration 0144: renter_applications persistence foundation (Phase 1)
--
-- Establishes a durable renter application record independent of email/localStorage
-- and defines explicit lifecycle + identity status columns for future Stripe Identity
-- integration without changing booking/payment flows.

CREATE TABLE IF NOT EXISTS renter_applications (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  phone                 text        NOT NULL,
  email                 text,
  age                   integer,
  experience            text        NOT NULL,
  apps                  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  agree_terms           boolean     NOT NULL DEFAULT false,
  agree_sms_consent     boolean     NOT NULL DEFAULT false,
  has_insurance         text,
  protection_plan_pref  text,
  license_file_name     text,
  license_mime_type     text,
  insurance_file_name   text,
  insurance_mime_type   text,
  has_license_upload    boolean     NOT NULL DEFAULT false,
  has_insurance_proof   boolean     NOT NULL DEFAULT false,
  precheck_decision     text,
  application_status    text        NOT NULL DEFAULT 'submitted',
  identity_status       text        NOT NULL DEFAULT 'not_started',
  identity_session_id   text,
  identity_verified_at  timestamptz,
  identity_last_error   text,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_age_check
      CHECK (age IS NULL OR (age >= 18 AND age <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_apps_check
      CHECK (jsonb_typeof(apps) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_has_insurance_check
      CHECK (has_insurance IS NULL OR has_insurance IN ('yes','no'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_protection_plan_pref_check
      CHECK (protection_plan_pref IS NULL OR protection_plan_pref IN ('basic','standard','premium','none'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_precheck_decision_check
      CHECK (precheck_decision IS NULL OR precheck_decision IN ('approved','review','declined'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_application_status_check
      CHECK (application_status IN ('submitted','under_review','approved','rejected','withdrawn','expired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_identity_status_check
      CHECK (identity_status IN ('not_started','requires_input','processing','verified','failed','canceled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_identity_verified_at_check
      CHECK (
        (identity_status = 'verified' AND identity_verified_at IS NOT NULL)
        OR (identity_status <> 'verified' AND identity_verified_at IS NULL)
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS renter_applications_identity_session_id_uq
  ON renter_applications (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS renter_applications_application_status_idx
  ON renter_applications (application_status, created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_identity_status_idx
  ON renter_applications (identity_status, created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_created_at_idx
  ON renter_applications (created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_phone_idx
  ON renter_applications (phone);

CREATE INDEX IF NOT EXISTS renter_applications_email_idx
  ON renter_applications (lower(email))
  WHERE email IS NOT NULL;

DROP TRIGGER IF EXISTS renter_applications_updated_at ON renter_applications;
CREATE TRIGGER renter_applications_updated_at
  BEFORE UPDATE ON renter_applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE renter_applications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE renter_applications FROM anon;
REVOKE ALL ON TABLE renter_applications FROM authenticated;
GRANT ALL ON TABLE renter_applications TO service_role;

DO $$
BEGIN
  CREATE POLICY renter_applications_service_role_all
    ON renter_applications
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
