-- Migration 0168: allow clear_declined admin audit action

ALTER TABLE application_review_actions
  DROP CONSTRAINT IF EXISTS application_review_actions_action_check;

ALTER TABLE application_review_actions
  ADD CONSTRAINT application_review_actions_action_check
    CHECK (action IN (
      'approved',
      'rejected',
      'needs_info',
      'pre_adverse',
      'move_to_review',
      'resend_verification',
      'restart_verification',
      'manual_recovery',
      'retry_checkr',
      'archive_test',
      'delete_application',
      'clear_declined'
    ));
