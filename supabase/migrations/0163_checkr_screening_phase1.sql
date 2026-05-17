-- Migration 0163: Checkr screening + adverse action + renter screening fields

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS agree_background_check boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver_license_number  text,
  ADD COLUMN IF NOT EXISTS driver_license_state   text,
  ADD COLUMN IF NOT EXISTS zipcode                text,
  ADD COLUMN IF NOT EXISTS checkr_adjudication    text,
  ADD COLUMN IF NOT EXISTS checkr_completed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_last_error      text,
  ADD COLUMN IF NOT EXISTS checkr_mvr_violations  jsonb,
  ADD COLUMN IF NOT EXISTS adverse_action_step    text,
  ADD COLUMN IF NOT EXISTS adverse_action_sent_at timestamptz;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_driver_license_state_check
      CHECK (
        driver_license_state IS NULL
        OR driver_license_state ~ '^[A-Z]{2}$'
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_zipcode_check
      CHECK (
        zipcode IS NULL
        OR zipcode ~ '^\d{5}(-\d{4})?$'
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_checkr_report_status_check
      CHECK (
        checkr_report_status IS NULL
        OR checkr_report_status IN ('pending', 'clear', 'consider', 'suspended', 'disputed', 'complete_no_adj', 'error')
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_adverse_action_step_check
      CHECK (
        adverse_action_step IS NULL
        OR adverse_action_step IN ('pre_notice_sent', 'final_notice_sent')
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    DROP CONSTRAINT IF EXISTS application_review_actions_action_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE application_review_actions
  ADD CONSTRAINT application_review_actions_action_check
    CHECK (action IN ('approved', 'rejected', 'needs_info', 'pre_adverse'));

CREATE INDEX IF NOT EXISTS renter_applications_checkr_candidate_idx
  ON renter_applications (checkr_candidate_id)
  WHERE checkr_candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_report_idx
  ON renter_applications (checkr_report_id)
  WHERE checkr_report_id IS NOT NULL;
