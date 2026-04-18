-- Migration 0055: explicit service-role policy for pending_booking_docs
--
-- 0054 already enables RLS for this table. This migration adds explicit
-- privilege and policy statements so access intent is clear in schema history:
-- only service_role can read/write rows.

REVOKE ALL ON TABLE pending_booking_docs FROM anon;
REVOKE ALL ON TABLE pending_booking_docs FROM authenticated;
GRANT ALL ON TABLE pending_booking_docs TO service_role;

CREATE POLICY IF NOT EXISTS pending_booking_docs_service_role_all
  ON pending_booking_docs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
