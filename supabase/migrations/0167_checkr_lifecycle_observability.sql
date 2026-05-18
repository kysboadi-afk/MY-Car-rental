-- Migration 0167: Checkr lifecycle observability + durable event log

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS checkr_last_launch_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_launch_attempt_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkr_last_launch_error      text,
  ADD COLUMN IF NOT EXISTS checkr_last_webhook_at        timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_phase                  text;

DO $$
BEGIN
  ALTER TABLE renter_applications
    DROP CONSTRAINT IF EXISTS renter_applications_checkr_report_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_checkr_report_status_check
      CHECK (
        checkr_report_status IS NULL
        OR checkr_report_status IN (
          'not_started',
          'launch_queued',
          'candidate_created',
          'invitation_sent',
          'pending',
          'completed',
          'clear',
          'consider',
          'suspended',
          'failed',
          'webhook_missing'
        )
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_checkr_phase_check
      CHECK (
        checkr_phase IS NULL
        OR checkr_phase IN (
          'not_started',
          'launch_queued',
          'candidate_created',
          'invitation_sent',
          'pending',
          'completed',
          'clear',
          'consider',
          'suspended',
          'failed',
          'webhook_missing'
        )
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_phase_idx
  ON renter_applications (checkr_phase)
  WHERE checkr_phase IS NOT NULL;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_last_webhook_at_idx
  ON renter_applications (checkr_last_webhook_at)
  WHERE checkr_last_webhook_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkr_screening_events (
  id                  bigserial   PRIMARY KEY,
  event_id            text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES public.renter_applications(id) ON DELETE SET NULL,
  checkr_candidate_id text,
  checkr_report_id    text,
  phase               text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkr_screening_events_application_id_idx
  ON checkr_screening_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS checkr_screening_events_candidate_id_idx
  ON checkr_screening_events (checkr_candidate_id)
  WHERE checkr_candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS checkr_screening_events_report_id_idx
  ON checkr_screening_events (checkr_report_id)
  WHERE checkr_report_id IS NOT NULL;

ALTER TABLE checkr_screening_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE checkr_screening_events FROM anon;
REVOKE ALL ON TABLE checkr_screening_events FROM authenticated;
GRANT ALL ON TABLE checkr_screening_events TO service_role;

DO $$
BEGIN
  CREATE POLICY checkr_screening_events_service_role_all
    ON checkr_screening_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
