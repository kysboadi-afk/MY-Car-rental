-- Migration 0048: Backfill customer records and booking links for rentals that
-- were created without a phone number in Stripe metadata, leaving customer_id
-- NULL on the bookings row and showing "–" in the admin Bookings table.
--
-- Affected customers / bookings (as of 2026-04-12):
--   • Brandon Bookhart  (+15303285561) — camry2013 bk-bb-2026-0402, bk-bb-2026-0407
--   • David Agbebaku    (+13463814616) — camry2013 bk-da-2026-0321, bk-da2-2026-0329
--                                        camry (2012)  bk-da-2026-0407
--
-- Safe to re-run: INSERT … ON CONFLICT DO UPDATE, UPDATE … IS DISTINCT FROM are
-- all idempotent.

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

  -- ── 5. Upsert David Agbebaku's camry 2012 booking (Apr 7–11 2026) ────────
  --  This booking was saved by the Stripe webhook but may have been stored with
  --  a random wh- booking_ref (or not stored at all if metadata was empty).
  --  Authoritative data from admin:
  --    pickup  2026-04-07  return  2026-04-11  amount $308.70  basic DPP
  INSERT INTO bookings (
    booking_ref, customer_id, vehicle_id,
    pickup_date, return_date,
    status, total_price, deposit_paid, remaining_balance,
    payment_status, payment_method,
    notes, updated_at
  )
  VALUES (
    'bk-da-2026-0407', v_david_id, 'camry',
    '2026-04-07', '2026-04-11',
    'completed', 308.70, 308.70, 0,
    'paid', 'stripe',
    '4-day rental. Basic DPP ($60). Sales tax $28.70. Full payment $308.70 via Stripe.',
    now()
  )
  ON CONFLICT (booking_ref) DO UPDATE SET
    customer_id       = EXCLUDED.customer_id,
    return_date       = EXCLUDED.return_date,
    status            = EXCLUDED.status,
    total_price       = EXCLUDED.total_price,
    deposit_paid      = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status    = EXCLUDED.payment_status,
    notes             = COALESCE(bookings.notes, EXCLUDED.notes),
    updated_at        = now();

  -- If a webhook row was saved with a wh- booking_ref for this same rental
  -- (vehicle camry, pickup 2026-04-07), update it to set customer_id + correct
  -- return date and link it to the canonical booking_ref row above.
  UPDATE bookings
  SET    customer_id = v_david_id,
         return_date = '2026-04-11',
         status      = 'completed',
         updated_at  = now()
  WHERE  vehicle_id  = 'camry'
    AND  pickup_date = '2026-04-07'
    AND  booking_ref <> 'bk-da-2026-0407'
    AND  customer_id IS DISTINCT FROM v_david_id;

  -- ── 6. Patch revenue_records for David's camry Apr 7 booking ─────────────
  UPDATE revenue_records
  SET    customer_name  = 'David Agbebaku',
         customer_phone = '+13463814616',
         customer_email = 'davosama15@gmail.com'
  WHERE  vehicle_id    = 'camry'
    AND  pickup_date   = '2026-04-07'
    AND  (customer_name IS NULL OR customer_name = '');

  -- ── 7. Patch revenue_records for Brandon's camry2013 bookings ────────────
  UPDATE revenue_records
  SET    customer_name  = 'Brandon Bookhart',
         customer_phone = '+15303285561',
         customer_email = 'brandon.bookhart@gmail.com'
  WHERE  booking_id IN ('bk-bb-2026-0402', 'bk-bb-2026-0407')
    AND  (customer_name IS NULL OR customer_name = '');

END $$;
