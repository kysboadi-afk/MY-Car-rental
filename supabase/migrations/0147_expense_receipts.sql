-- Expense receipt uploads for fleet expenses / expenses admin UI.
-- Safe to re-run.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS receipt_url text,
  ADD COLUMN IF NOT EXISTS receipt_filename text,
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_size integer,
  ADD COLUMN IF NOT EXISTS receipt_mime_type text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'fleet_expenses'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE fleet_expenses
        ADD COLUMN IF NOT EXISTS receipt_url text,
        ADD COLUMN IF NOT EXISTS receipt_filename text,
        ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz,
        ADD COLUMN IF NOT EXISTS receipt_size integer,
        ADD COLUMN IF NOT EXISTS receipt_mime_type text
    $sql$;
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts',
  'expense-receipts',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf'];

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense-receipts: service write" ON storage.objects;

CREATE POLICY "expense-receipts: service write"
  ON storage.objects FOR ALL
  USING     (bucket_id = 'expense-receipts' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'expense-receipts' AND auth.role() = 'service_role');
