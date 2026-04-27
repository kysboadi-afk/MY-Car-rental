-- Migration 0099: Backfill Anthony Johnson camry booking (bk-da88f9ade3d1)
--
-- Context:
--   A payment of $385.88 was received for camry (Camry 2012) from Anthony Johnson
--   (booking bk-da88f9ade3d1, pickup 2026-04-23 18:00, return 2026-04-30 18:00,
--    stripe_customer_id cus_UO2eMoHJZAbXQd).  The vehicle is showing as Available
--   on the website despite an active rental being in progress.
--
-- This migration:
--   1. Upserts the customer record for Anthony Johnson.
--   2. Upserts the booking as active_rental (pickup already occurred 2026-04-23).
--   3. Inserts / repairs the blocked_dates row for camry so fleet-status.js
--      immediately reflects the vehicle as unavailable (returns 2026-04-30 20:00
--      after the standard 2-hour buffer).
--
-- Safe to re-run: all writes are idempotent.

DO $$
DECLARE
  v_customer_id uuid;
BEGIN

  -- ── 1. Upsert customer: Anthony Johnson ────────────────────────────────────
  INSERT INTO public.customers (name, phone, email, updated_at)
  VALUES ('Anthony Johnson', '+12138011313', 'cheftony90@icloud.com', now())
  ON CONFLICT (phone) DO UPDATE
    SET name       = EXCLUDED.name,
        email      = COALESCE(EXCLUDED.email, customers.email),
        updated_at = now()
  RETURNING id INTO v_customer_id;

  IF v_customer_id IS NULL THEN
    SELECT id INTO v_customer_id
    FROM   public.customers
    WHERE  phone = '+12138011313';
  END IF;

  -- ── 2. Upsert booking bk-da88f9ade3d1 ──────────────────────────────────────
  -- Pickup was 18:00 on 2026-04-23 (already past), return is 2026-04-30 18:00,
  -- so status is active_rental.
  INSERT INTO public.bookings (
    booking_ref, customer_id, vehicle_id,
    pickup_date, return_date,
    pickup_time, return_time,
    status, total_price, deposit_paid, remaining_balance,
    payment_status, payment_method,
    stripe_customer_id,
    customer_name, customer_email, customer_phone,
    notes, updated_at
  )
  VALUES (
    'bk-da88f9ade3d1', v_customer_id, 'camry',
    '2026-04-23', '2026-04-30',
    '18:00:00', '18:00:00',
    'active_rental', 385.88, 385.88, 0.00,
    'paid', 'stripe',
    'cus_UO2eMoHJZAbXQd',
    'Anthony Johnson', 'cheftony90@icloud.com', '+12138011313',
    'Full payment $385.88 via Stripe. Weekly rental. Backfilled via migration 0099.',
    now()
  )
  ON CONFLICT (booking_ref) DO UPDATE
    -- Only upgrade the status; never downgrade a terminal state.
    SET status = CASE
          WHEN bookings.status IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental')
          THEN bookings.status
          ELSE 'active_rental'
        END,
        total_price        = EXCLUDED.total_price,
        deposit_paid       = EXCLUDED.deposit_paid,
        remaining_balance  = EXCLUDED.remaining_balance,
        payment_status     = EXCLUDED.payment_status,
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, bookings.stripe_customer_id),
        customer_id        = COALESCE(EXCLUDED.customer_id, bookings.customer_id),
        updated_at         = now();

  -- ── 3. Insert / repair blocked_dates for bk-da88f9ade3d1 ───────────────────
  -- Buffer: return_time 18:00 + PICKUP_BUFFER_HOURS(2) = 20:00.
  INSERT INTO public.blocked_dates (
    vehicle_id, start_date, end_date, end_time, reason, booking_ref
  )
  VALUES (
    'camry', '2026-04-23', '2026-04-30', '20:00:00', 'booking', 'bk-da88f9ade3d1'
  )
  ON CONFLICT (vehicle_id, start_date, end_date, reason)
  DO UPDATE SET
    end_time    = COALESCE(EXCLUDED.end_time,    blocked_dates.end_time),
    booking_ref = COALESCE(EXCLUDED.booking_ref, blocked_dates.booking_ref),
    updated_at  = now();

END $$;
