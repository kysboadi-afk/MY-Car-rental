-- Ensure booking vehicle IDs always reference an existing vehicle record.
-- Also normalize the legacy Camry 2012 ID used in old records.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.vehicles
    WHERE vehicle_id = 'camry'
  ) THEN
    RAISE EXCEPTION
      'Required canonical vehicle_id "camry" is missing in public.vehicles; aborting migration before bookings vehicle_id FK enforcement.';
  END IF;
END $$;

UPDATE public.bookings
SET vehicle_id = 'camry'
WHERE vehicle_id = 'camry2012';

DO $$
DECLARE
  existing_fk_name text;
BEGIN
  SELECT con.conname
    INTO existing_fk_name
  FROM pg_constraint con
  JOIN pg_class rel
    ON rel.oid = con.conrelid
  JOIN pg_namespace nsp
    ON nsp.oid = rel.relnamespace
  JOIN pg_attribute att
    ON att.attrelid = rel.oid
   AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f'
    AND nsp.nspname = 'public'
    AND rel.relname = 'bookings'
    AND att.attname = 'vehicle_id'
    AND con.confrelid = 'public.vehicles'::regclass
  LIMIT 1;

  IF existing_fk_name IS NULL THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_vehicle_id_fkey
      FOREIGN KEY (vehicle_id)
      REFERENCES public.vehicles(vehicle_id)
      ON DELETE RESTRICT;
    existing_fk_name := 'bookings_vehicle_id_fkey';
  END IF;

  EXECUTE format(
    'ALTER TABLE public.bookings VALIDATE CONSTRAINT %I',
    existing_fk_name
  );
END $$;
