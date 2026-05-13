-- Migration 0146: Phase 3 — admin review operations
--
-- Extends renter_applications with:
--   • review_version        — monotonic counter for optimistic concurrency protection
--   • needs_info_reason     — reason text when action is "needs_info"
--   • last_reviewer_notes   — freeform notes from the most recent reviewer
--   • checkr_candidate_id,
--     checkr_report_id,
--     checkr_report_status,
--     checkr_mvr_status     — inert Checkr attachment points (nullable, no integration yet)
--
-- Expands application_status to include "needs_info".
--
-- Creates application_review_actions (append-only audit table) with:
--   • action_request_id uniqueness constraint to prevent duplicate submissions.

-- ── 1. New columns on renter_applications ─────────────────────────────────────

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS review_version       bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS needs_info_reason    text,
  ADD COLUMN IF NOT EXISTS last_reviewer_notes  text,
  ADD COLUMN IF NOT EXISTS checkr_candidate_id  text,
  ADD COLUMN IF NOT EXISTS checkr_report_id     text,
  ADD COLUMN IF NOT EXISTS checkr_report_status text,
  ADD COLUMN IF NOT EXISTS checkr_mvr_status    text;

-- ── 2. Expand the application_status check constraint to include needs_info ───

DO $$
BEGIN
  ALTER TABLE renter_applications
    DROP CONSTRAINT IF EXISTS renter_applications_application_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE renter_applications
  ADD CONSTRAINT renter_applications_application_status_check
    CHECK (application_status IN (
      'submitted', 'under_review', 'needs_info',
      'approved',  'rejected', 'withdrawn', 'expired'
    ));

-- ── 3. application_review_actions audit table ─────────────────────────────────

CREATE TABLE IF NOT EXISTS application_review_actions (
  id                bigserial    PRIMARY KEY,
  application_id    uuid         NOT NULL REFERENCES renter_applications(id) ON DELETE CASCADE,
  action            text         NOT NULL,
  performed_by      text         NOT NULL,
  notes             text,
  previous_status   text         NOT NULL,
  new_status        text         NOT NULL,
  action_request_id uuid         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_action_check
      CHECK (action IN ('approved', 'rejected', 'needs_info'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_previous_status_check
      CHECK (previous_status IN (
        'submitted', 'under_review', 'needs_info',
        'approved',  'rejected', 'withdrawn', 'expired'
      ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_new_status_check
      CHECK (new_status IN (
        'submitted', 'under_review', 'needs_info',
        'approved',  'rejected', 'withdrawn', 'expired'
      ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Idempotency: one action per (application, request-id)
CREATE UNIQUE INDEX IF NOT EXISTS application_review_actions_idempotency_uq
  ON application_review_actions (application_id, action_request_id);

CREATE INDEX IF NOT EXISTS application_review_actions_application_id_idx
  ON application_review_actions (application_id, created_at DESC);

ALTER TABLE application_review_actions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE application_review_actions FROM anon;
REVOKE ALL ON TABLE application_review_actions FROM authenticated;
GRANT  ALL ON TABLE application_review_actions TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE application_review_actions_id_seq TO service_role;

DO $$
BEGIN
  CREATE POLICY application_review_actions_service_role_all
    ON application_review_actions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
