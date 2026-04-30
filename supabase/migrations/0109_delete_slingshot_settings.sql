-- Remove all Slingshot-related entries from system_settings.
-- The Slingshot is no longer offered for rental.
DELETE FROM system_settings
WHERE key LIKE 'slingshot%';
