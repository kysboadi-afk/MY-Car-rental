-- Migration 0160: Phase 4 operational automation foundation for car-rental
-- extension risk management.
--
-- Adds additive tables for:
--   • current risk profile / review state
--   • append-only risk events
--   • operational alerts
--   • internal notes and tagging
--
-- Scope is intentionally limited to category='car'.

CREATE TABLE IF NOT EXISTS extension_risk_profiles (
  id                       bigserial    PRIMARY KEY,
  booking_ref              text         NOT NULL,
  customer_id              text,
  category                 text         NOT NULL DEFAULT 'car',
  current_state            text         NOT NULL DEFAULT 'clear',
  recommended_state        text         NOT NULL DEFAULT 'clear',
  active_override_state    text,
  extension_override_mode  text,
  restricted_extension     boolean      NOT NULL DEFAULT false,
  manual_review_required   boolean      NOT NULL DEFAULT false,
  full_payment_required    boolean      NOT NULL DEFAULT false,
  review_status            text         NOT NULL DEFAULT 'not_queued',
  review_priority          integer      NOT NULL DEFAULT 0,
  open_alert_count         integer      NOT NULL DEFAULT 0,
  signals                  jsonb        NOT NULL DEFAULT '{}'::jsonb,
  reasons                  jsonb        NOT NULL DEFAULT '[]'::jsonb,
  operational_tags         jsonb        NOT NULL DEFAULT '[]'::jsonb,
  notes_summary            text,
  last_evaluated_at        timestamptz  NOT NULL DEFAULT now(),
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_current_state_check
      CHECK (current_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_recommended_state_check
      CHECK (recommended_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_active_override_state_check
      CHECK (active_override_state IS NULL OR active_override_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_extension_override_mode_check
      CHECK (extension_override_mode IS NULL OR extension_override_mode IN ('allow', 'block'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_review_status_check
      CHECK (review_status IN ('not_queued', 'queued', 'in_review', 'resolved'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS extension_risk_profiles_booking_ref_uq
  ON extension_risk_profiles (booking_ref);

CREATE INDEX IF NOT EXISTS extension_risk_profiles_state_idx
  ON extension_risk_profiles (current_state, review_status, review_priority DESC, last_evaluated_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_profiles_customer_idx
  ON extension_risk_profiles (customer_id, current_state);

CREATE TABLE IF NOT EXISTS extension_risk_events (
  id                bigserial    PRIMARY KEY,
  booking_ref       text         NOT NULL,
  customer_id       text,
  category          text         NOT NULL DEFAULT 'car',
  event_type        text         NOT NULL,
  previous_state    text         NOT NULL DEFAULT 'clear',
  new_state         text         NOT NULL DEFAULT 'clear',
  recommended_state text         NOT NULL DEFAULT 'clear',
  actor_type        text         NOT NULL DEFAULT 'system',
  actor_label       text         NOT NULL DEFAULT 'extension-risk-automation',
  trigger_source    text         NOT NULL DEFAULT 'manual',
  reasons           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  signal_snapshot   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot   jsonb,
  alerts            jsonb        NOT NULL DEFAULT '[]'::jsonb,
  request_id        text,
  created_at        timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_previous_state_check
      CHECK (previous_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_new_state_check
      CHECK (new_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_recommended_state_check
      CHECK (recommended_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS extension_risk_events_booking_ref_idx
  ON extension_risk_events (booking_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_events_customer_idx
  ON extension_risk_events (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_events_state_idx
  ON extension_risk_events (new_state, created_at DESC);

CREATE TABLE IF NOT EXISTS extension_risk_alerts (
  id               bigserial    PRIMARY KEY,
  booking_ref      text         NOT NULL,
  customer_id      text,
  category         text         NOT NULL DEFAULT 'car',
  risk_state       text         NOT NULL DEFAULT 'clear',
  alert_type       text         NOT NULL,
  severity         text         NOT NULL DEFAULT 'warning',
  status           text         NOT NULL DEFAULT 'pending',
  dedupe_key       text         NOT NULL,
  channel          text         NOT NULL DEFAULT 'internal',
  payload          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  triggered_at     timestamptz  NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text
);

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_state_check
      CHECK (risk_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_severity_check
      CHECK (severity IN ('info', 'warning', 'high', 'critical'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_status_check
      CHECK (status IN ('pending', 'acknowledged', 'resolved', 'dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS extension_risk_alerts_dedupe_key_uq
  ON extension_risk_alerts (dedupe_key);

CREATE INDEX IF NOT EXISTS extension_risk_alerts_queue_idx
  ON extension_risk_alerts (status, severity, triggered_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_alerts_booking_ref_idx
  ON extension_risk_alerts (booking_ref, triggered_at DESC);

CREATE TABLE IF NOT EXISTS extension_risk_notes (
  id             bigserial    PRIMARY KEY,
  booking_ref    text         NOT NULL,
  customer_id    text,
  category       text         NOT NULL DEFAULT 'car',
  note           text         NOT NULL,
  tags           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  visibility     text         NOT NULL DEFAULT 'internal',
  created_by     text         NOT NULL DEFAULT 'system',
  created_at     timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE extension_risk_notes
    ADD CONSTRAINT extension_risk_notes_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_notes
    ADD CONSTRAINT extension_risk_notes_visibility_check
      CHECK (visibility IN ('internal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS extension_risk_notes_booking_ref_idx
  ON extension_risk_notes (booking_ref, created_at DESC);

CREATE OR REPLACE VIEW extension_risk_review_queue AS
SELECT
  p.booking_ref,
  p.customer_id,
  p.current_state,
  p.recommended_state,
  p.review_status,
  p.review_priority,
  p.open_alert_count,
  p.signals,
  p.reasons,
  p.operational_tags,
  p.notes_summary,
  p.last_evaluated_at
FROM extension_risk_profiles p
WHERE p.current_state <> 'clear'
   OR p.review_status <> 'not_queued'
   OR p.open_alert_count > 0;

ALTER TABLE extension_risk_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_risk_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_risk_notes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE extension_risk_profiles FROM anon, authenticated;
REVOKE ALL ON TABLE extension_risk_events FROM anon, authenticated;
REVOKE ALL ON TABLE extension_risk_alerts FROM anon, authenticated;
REVOKE ALL ON TABLE extension_risk_notes FROM anon, authenticated;

GRANT ALL ON TABLE extension_risk_profiles TO service_role;
GRANT ALL ON TABLE extension_risk_events TO service_role;
GRANT ALL ON TABLE extension_risk_alerts TO service_role;
GRANT ALL ON TABLE extension_risk_notes TO service_role;

GRANT USAGE, SELECT ON SEQUENCE extension_risk_profiles_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE extension_risk_events_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE extension_risk_alerts_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE extension_risk_notes_id_seq TO service_role;

DO $$
BEGIN
  CREATE POLICY extension_risk_profiles_service_role_all
    ON extension_risk_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY extension_risk_events_service_role_all
    ON extension_risk_events FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY extension_risk_alerts_service_role_all
    ON extension_risk_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY extension_risk_notes_service_role_all
    ON extension_risk_notes FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
