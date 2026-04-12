-- Migration 0048: Backfill customer links for bookings that were created without
-- a phone number in the Stripe metadata, leaving customer_id NULL on the
-- bookings row and showing "–" in the admin Bookings table.
--
-- Affected bookings (as of 2026-04-12):
--   • camry2013 bookings for Brandon Bookhart (bk-bb-2026-0402, bk-bb-2026-0407)
--   • camry       active booking for David Agbebaku (pickup 2026-04-07)
--
-- Safe to re-run: all statements are idempotent (ON CONFLICT DO UPDATE / DO NOTHING).

DO $$
DECLARE
  v_brandon_id   uuid;
  v_david_id     uuid;
BEGIN

  -- ── 1. Upsert customer: Brandon Bookhart ──────────────────────────────────
  INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
  VALUES ('Brandon Bookhart', '+15303285561', 'brandon.bookhart@gmail.com', 0, 0, '2026-04-02', '2026-04-07')
  ON CONFLICT (phone) DO UPDATE SET
    name       = EXCLUDED.name,
    email      = COALESCE(EXCLUDED.email, customers.email),
    updated_at = now()
  RETURNING id INTO v_brandon_id;

  -- If the row already existed, ON CONFLICT branch doesn't return via RETURNING.
  -- Fetch the id explicitly when needed.
  IF v_brandon_id IS NULL THEN
    SELECT id INTO v_brandon_id FROM customers WHERE phone = '+15303285561';
  END IF;

  -- ── 2. Upsert customer: David Agbebaku ───────────────────────────────────
  INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
  VALUES ('David Agbebaku', '+13463814616', 'davosama15@gmail.com', 0, 0, '2026-03-21', '2026-04-07')
  ON CONFLICT (phone) DO UPDATE SET
    name       = EXCLUDED.name,
    email      = COALESCE(EXCLUDED.email, customers.email),
    updated_at = now()
  RETURNING id INTO v_david_id;

  IF v_david_id IS NULL THEN
    SELECT id INTO v_david_id FROM customers WHERE phone = '+13463814616';
  END IF;

  -- ── 3. Link Brandon Bookhart to his camry2013 bookings ───────────────────
  UPDATE bookings
  SET    customer_id = v_brandon_id, updated_at = now()
  WHERE  vehicle_id  = 'camry2013'
    AND  booking_ref IN ('bk-bb-2026-0402', 'bk-bb-2026-0407')
    AND  customer_id IS DISTINCT FROM v_brandon_id;

  -- ── 4. Link David Agbebaku to his camry2013 bookings ────────────────────
  UPDATE bookings
  SET    customer_id = v_david_id, updated_at = now()
  WHERE  vehicle_id  = 'camry2013'
    AND  booking_ref IN ('bk-da-2026-0321', 'bk-da2-2026-0329')
    AND  customer_id IS DISTINCT FROM v_david_id;

  -- ── 5. Link David Agbebaku to the camry (2012) active booking ────────────
  --  This booking was saved by the Stripe webhook without name/phone in metadata.
  --  Match by vehicle + pickup date (unique in practice for this date).
  UPDATE bookings
  SET    customer_id = v_david_id, updated_at = now()
  WHERE  vehicle_id  = 'camry'
    AND  pickup_date = '2026-04-07'
    AND  customer_id IS DISTINCT FROM v_david_id;

  -- ── 6. Patch revenue_records customer fields for the camry April 7 booking ─
  --  The row was written by the webhook with blank customer_name/phone/email.
  UPDATE revenue_records
  SET    customer_name  = 'David Agbebaku',
         customer_phone = '+13463814616',
         customer_email = 'davosama15@gmail.com'
  WHERE  vehicle_id    = 'camry'
    AND  pickup_date   = '2026-04-07'
    AND  (customer_name IS NULL OR customer_name = '');

  -- Patch revenue_records for Brandon Bookhart's bookings (in case they were
  -- also missing customer info).
  UPDATE revenue_records
  SET    customer_name  = 'Brandon Bookhart',
         customer_phone = '+15303285561',
         customer_email = 'brandon.bookhart@gmail.com'
  WHERE  booking_id IN ('bk-bb-2026-0402', 'bk-bb-2026-0407')
    AND  (customer_name IS NULL OR customer_name = '');

END $$;
