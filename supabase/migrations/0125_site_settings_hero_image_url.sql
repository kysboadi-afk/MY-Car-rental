-- Migration 0125: add hero_image_url to site_settings
-- Inserts a default empty row for the hero_image_url key so the public
-- site-content API returns it in its settings object. The value is managed
-- via the admin panel (admin-v2 → Settings → Hero Section).

INSERT INTO site_settings (key, value, updated_at)
VALUES ('hero_image_url', '', NOW())
ON CONFLICT (key) DO NOTHING;
