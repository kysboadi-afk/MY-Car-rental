-- Migration 0170: Ensure Veriff webhook event log table exists everywhere.
--
-- Some environments may have only the legacy stripe_identity_webhook_events
-- table. This migration guarantees the Veriff-named table exists so webhook
-- dedupe/event logging does not depend on fallback behavior.

CREATE TABLE IF NOT EXISTS veriff_webhook_events (
  id                  bigserial   PRIMARY KEY,
  event_id            text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES public.renter_applications(id) ON DELETE SET NULL,
  identity_session_id text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS veriff_webhook_events_application_id_idx
  ON veriff_webhook_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS veriff_webhook_events_identity_session_id_idx
  ON veriff_webhook_events (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

ALTER TABLE veriff_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE veriff_webhook_events FROM anon;
REVOKE ALL ON TABLE veriff_webhook_events FROM authenticated;
GRANT ALL ON TABLE veriff_webhook_events TO service_role;

DO $$
BEGIN
  CREATE POLICY veriff_webhook_events_service_role_all
    ON veriff_webhook_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
