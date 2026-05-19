-- Migration 0171: ensure bookings.extension_risk_override exists for v2-bookings
-- full-select paths and extension-risk controls.
--
-- This is additive and safe to run repeatedly.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS extension_risk_override text;

DO $$
BEGIN
  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_extension_risk_override_check
      CHECK (extension_risk_override IS NULL OR extension_risk_override IN ('allow', 'block'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.bookings.extension_risk_override IS
  'Per-booking admin override for extension risk gate. NULL=default policy, allow=force allow, block=force restricted extension posture.';
