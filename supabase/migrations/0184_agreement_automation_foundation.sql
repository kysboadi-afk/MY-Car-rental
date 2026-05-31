-- Migration 0184: Agreement automation foundation (Phase 1)
-- Creates versioned agreement templates, booking agreement versions,
-- and auditable per-agreement signatures.
--
-- Safe to re-run: IF NOT EXISTS guards + conflict-safe seed insert.

CREATE TABLE IF NOT EXISTS public.agreement_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key   text NOT NULL,
  version        integer NOT NULL CHECK (version > 0),
  status         text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  template_body  text,
  schema_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz,
  effective_to   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text
);

CREATE UNIQUE INDEX IF NOT EXISTS agreement_templates_template_key_version_uidx
  ON public.agreement_templates (template_key, version);

CREATE UNIQUE INDEX IF NOT EXISTS agreement_templates_active_template_uidx
  ON public.agreement_templates (template_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS agreement_templates_lookup_idx
  ON public.agreement_templates (template_key, status, effective_from DESC);

CREATE TABLE IF NOT EXISTS public.booking_agreements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref      text NOT NULL REFERENCES public.bookings(booking_ref) ON DELETE CASCADE,
  template_id      uuid REFERENCES public.agreement_templates(id) ON DELETE SET NULL,
  agreement_type   text NOT NULL,
  version_number   integer NOT NULL CHECK (version_number > 0),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'signed', 'voided')),
  payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_storage_path text,
  pdf_sha256       text,
  signed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_ref, version_number)
);

CREATE INDEX IF NOT EXISTS booking_agreements_booking_ref_idx
  ON public.booking_agreements (booking_ref, version_number DESC);

CREATE INDEX IF NOT EXISTS booking_agreements_template_id_idx
  ON public.booking_agreements (template_id);

CREATE INDEX IF NOT EXISTS booking_agreements_status_idx
  ON public.booking_agreements (status);

CREATE TABLE IF NOT EXISTS public.booking_agreement_signatures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id        uuid NOT NULL REFERENCES public.booking_agreements(id) ON DELETE CASCADE,
  signer_role         text NOT NULL,
  signer_name         text,
  signature_method    text NOT NULL,
  signature_text      text,
  signature_hash      text NOT NULL,
  ip_address          text,
  user_agent          text,
  identity_session_id text,
  signed_at           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, signer_role)
);

CREATE INDEX IF NOT EXISTS booking_agreement_signatures_agreement_id_idx
  ON public.booking_agreement_signatures (agreement_id);

CREATE INDEX IF NOT EXISTS booking_agreement_signatures_signed_at_idx
  ON public.booking_agreement_signatures (signed_at DESC);

ALTER TABLE public.agreement_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_agreement_signatures ENABLE ROW LEVEL SECURITY;

INSERT INTO public.agreement_templates (
  template_key,
  version,
  status,
  template_body,
  schema_json,
  effective_from,
  created_by
)
VALUES (
  'rental_standard',
  1,
  'active',
  'SLY rental agreement template v1',
  '{"render_engine":"api/_rental-agreement-pdf.js","agreement_type":"rental_initial"}'::jsonb,
  now(),
  'migration_0184'
)
ON CONFLICT (template_key, version) DO NOTHING;
