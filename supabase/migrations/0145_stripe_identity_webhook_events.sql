-- Migration 0145: Stripe Identity webhook idempotency log
--
-- Stores processed Stripe Identity webhook event IDs so webhook handling
-- is idempotent across retries/replays.

CREATE TABLE IF NOT EXISTS stripe_identity_webhook_events (
  id                  bigserial   PRIMARY KEY,
  stripe_event_id     text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES renter_applications(id) ON DELETE SET NULL,
  identity_session_id text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_identity_webhook_events_application_id_idx
  ON stripe_identity_webhook_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS stripe_identity_webhook_events_identity_session_id_idx
  ON stripe_identity_webhook_events (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

ALTER TABLE stripe_identity_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE stripe_identity_webhook_events FROM anon;
REVOKE ALL ON TABLE stripe_identity_webhook_events FROM authenticated;
GRANT ALL ON TABLE stripe_identity_webhook_events TO service_role;

DO $$
BEGIN
  CREATE POLICY stripe_identity_webhook_events_service_role_all
    ON stripe_identity_webhook_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
