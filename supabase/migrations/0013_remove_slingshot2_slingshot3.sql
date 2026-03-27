-- Migration: Remove slingshot2 and slingshot3, update slingshot cover image
-- Run this in the Supabase SQL editor or via the Supabase CLI.
--
-- The fleet has been consolidated to a single Slingshot unit.
-- This removes the unused vehicle rows and updates the cover image
-- for the remaining slingshot to the newly uploaded photo.

-- Remove the extra Slingshot units from the vehicles table
DELETE FROM vehicles WHERE vehicle_id IN ('slingshot2', 'slingshot3');

-- Update the slingshot cover image to the real uploaded photo
UPDATE vehicles
SET data = jsonb_set(data, '{cover_image}', '"/images/slingshot.jpg"')
WHERE vehicle_id = 'slingshot';

-- Also set the vehicle_name to the canonical display name
UPDATE vehicles
SET data = jsonb_set(data, '{vehicle_name}', '"Slingshot R"')
WHERE vehicle_id = 'slingshot';
