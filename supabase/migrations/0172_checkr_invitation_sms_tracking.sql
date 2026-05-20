-- Migration 0172: Checkr invitation URL + SMS tracking fields

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS checkr_invitation_url text,
  ADD COLUMN IF NOT EXISTS checkr_invitation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_invitation_sms_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_invitation_reminder_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_invitation_pending_idx
  ON renter_applications (checkr_report_status, checkr_invitation_sent_at)
  WHERE checkr_invitation_url IS NOT NULL;
