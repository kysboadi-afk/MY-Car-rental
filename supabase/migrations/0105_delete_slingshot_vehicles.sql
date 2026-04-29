-- Remove all slingshot vehicles from the fleet.
-- Slingshot units are no longer offered for rental.
DELETE FROM vehicles
WHERE vehicle_id LIKE 'slingshot%'
   OR (data->>'type') = 'slingshot';
