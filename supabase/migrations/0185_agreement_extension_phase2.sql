-- Migration 0185: Agreement automation + extension lifecycle (Phase 2)
-- Additive only:
--   1) Agreement delivery tracking columns
--   2) Extension reason metadata
--   3) Extension request lifecycle table
--   4) Booking event timeline table

ALTER TABLE public.booking_agreements
  ADD COLUMN IF NOT EXISTS owner_delivery_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS renter_delivery_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'booking_agreements_owner_delivery_status_chk'
      AND conrelid = 'public.booking_agreements'::regclass
  ) THEN
    ALTER TABLE public.booking_agreements
      ADD CONSTRAINT booking_agreements_owner_delivery_status_chk
      CHECK (owner_delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'skipped'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'booking_agreements_renter_delivery_status_chk'
      AND conrelid = 'public.booking_agreements'::regclass
  ) THEN
    ALTER TABLE public.booking_agreements
      ADD CONSTRAINT booking_agreements_renter_delivery_status_chk
      CHECK (renter_delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS booking_agreements_delivery_status_idx
  ON public.booking_agreements (booking_ref, owner_delivery_status, renter_delivery_status, version_number DESC);

ALTER TABLE public.booking_extensions
  ADD COLUMN IF NOT EXISTS extension_reason text,
  ADD COLUMN IF NOT EXISTS extension_notes text;

CREATE TABLE IF NOT EXISTS public.booking_extension_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref          text NOT NULL REFERENCES public.bookings(booking_ref) ON DELETE CASCADE,
  payment_intent_id    text UNIQUE,
  requested_return_date date NOT NULL,
  requested_return_time time,
  extension_reason     text,
  extension_notes      text,
  payment_status       text NOT NULL DEFAULT 'pending',
  signature_status     text NOT NULL DEFAULT 'pending',
  signature_required   boolean NOT NULL DEFAULT false,
  lifecycle_status     text NOT NULL DEFAULT 'requested',
  requested_by         text NOT NULL DEFAULT 'renter',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'booking_extension_requests_payment_status_chk'
      AND conrelid = 'public.booking_extension_requests'::regclass
  ) THEN
    ALTER TABLE public.booking_extension_requests
      ADD CONSTRAINT booking_extension_requests_payment_status_chk
      CHECK (payment_status IN ('pending', 'completed', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'booking_extension_requests_signature_status_chk'
      AND conrelid = 'public.booking_extension_requests'::regclass
  ) THEN
    ALTER TABLE public.booking_extension_requests
      ADD CONSTRAINT booking_extension_requests_signature_status_chk
      CHECK (signature_status IN ('pending', 'completed', 'waived', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'booking_extension_requests_lifecycle_status_chk'
      AND conrelid = 'public.booking_extension_requests'::regclass
  ) THEN
    ALTER TABLE public.booking_extension_requests
      ADD CONSTRAINT booking_extension_requests_lifecycle_status_chk
      CHECK (
        lifecycle_status IN (
          'requested',
          'payment_pending',
          'payment_completed',
          'signature_pending',
          'ready_for_booking_update',
          'applied',
          'payment_failed',
          'signature_failed',
          'cancelled'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS booking_extension_requests_booking_ref_idx
  ON public.booking_extension_requests (booking_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS booking_extension_requests_lifecycle_idx
  ON public.booking_extension_requests (lifecycle_status, payment_status, signature_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.booking_event_timeline (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref text NOT NULL REFERENCES public.bookings(booking_ref) ON DELETE CASCADE,
  event_type  text NOT NULL,
  event_key   text UNIQUE,
  actor       text NOT NULL DEFAULT 'system',
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_event_timeline_booking_ref_idx
  ON public.booking_event_timeline (booking_ref, occurred_at DESC);

CREATE INDEX IF NOT EXISTS booking_event_timeline_event_type_idx
  ON public.booking_event_timeline (event_type, occurred_at DESC);

ALTER TABLE public.booking_extension_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_event_timeline ENABLE ROW LEVEL SECURITY;
