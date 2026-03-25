-- =============================================================================
-- SLY RIDES — Migration 0008: Vehicle Image Storage Bucket
-- =============================================================================
--
-- HOW TO USE
-- ----------
-- 1. Open your Supabase project → SQL Editor → New Query
-- 2. Paste this ENTIRE file and click Run
--
-- WHAT THIS DOES
-- --------------
-- 1. Creates a public Supabase Storage bucket called "vehicle-images"
-- 2. Adds RLS (Row Level Security) policies so:
--    • Anyone can READ/VIEW images (required for public <img> tags)
--    • Only the service role (Vercel backend) can UPLOAD / DELETE images
-- =============================================================================

-- 1. Create the bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-images',
  'vehicle-images',
  true,
  5242880,  -- 5 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif'];

-- 2. Enable RLS on storage.objects (usually already enabled, safe to run)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3. Drop any stale policies for this bucket before recreating them
DROP POLICY IF EXISTS "vehicle-images: public read"   ON storage.objects;
DROP POLICY IF EXISTS "vehicle-images: service write" ON storage.objects;

-- 4. Allow anyone to read images from this bucket (needed for <img> tags on the site)
CREATE POLICY "vehicle-images: public read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'vehicle-images');

-- 5. Allow only the service role (our Vercel backend) to insert / update / delete
CREATE POLICY "vehicle-images: service write"
  ON storage.objects
  FOR ALL
  USING (bucket_id = 'vehicle-images' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'vehicle-images' AND auth.role() = 'service_role');
