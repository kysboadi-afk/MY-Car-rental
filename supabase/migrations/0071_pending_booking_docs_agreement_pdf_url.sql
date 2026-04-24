-- Migration 0071: add agreement_pdf_url to pending_booking_docs
--                 and create rental-agreements Storage bucket.
--
-- Purpose: store the path to the generated rental-agreement PDF so that
-- recovery flows (admin-resend-booking, toolResendBookingConfirmation) can
-- retrieve and re-attach it without regenerating from scratch.
--
-- Safe to re-run: all statements use IF NOT EXISTS / DO $$ guards.

-- 1. Add agreement_pdf_url column (stores the Supabase Storage object path)
ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS agreement_pdf_url text;

-- 2. Create a private rental-agreements storage bucket.
--    file_size_limit: 10 MB (PDFs are rarely > 1 MB, generous headroom)
--    public: false — PDFs must not be publicly accessible without auth.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rental-agreements',
  'rental-agreements',
  false,
  10485760,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- 3. Service-role only access (no public reads, no anonymous writes).
DROP POLICY IF EXISTS "rental-agreements: service write" ON storage.objects;
CREATE POLICY "rental-agreements: service write"
  ON storage.objects FOR ALL
  USING     (bucket_id = 'rental-agreements' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'rental-agreements' AND auth.role() = 'service_role');
