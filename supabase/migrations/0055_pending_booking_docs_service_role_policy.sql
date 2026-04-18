-- Migration 0055: explicit service-role policy for pending_booking_docs
--
-- 0054 enabled RLS for this table. This migration makes the intended access
-- model explicit: only service_role can read/write rows.

ALTER TABLE pending_booking_docs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE pending_booking_docs FROM anon;
REVOKE ALL ON TABLE pending_booking_docs FROM authenticated;
GRANT ALL ON TABLE pending_booking_docs TO service_role;

CREATE POLICY IF NOT EXISTS pending_booking_docs_service_role_all
  ON pending_booking_docs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
