-- Migration 0097: Fix stale active_rental bookings and backfill stuck payment
--
-- Context:
--   On 2026-04-27 a payment of $60.64 was received for camry2013 (Brandon Bookhart,
--   booking bk-bc8b0ddcc89e, pickup 2026-04-27, return 2026-04-28).  Both the Stripe
--   webhook and the scheduled-reminders repair attempt failed with "Repair failed".
--
-- Root causes addressed by this migration:
--
--   1. Stale bookings in Supabase with status='active_rental' long past their
--      return_date.  The check_booking_conflicts trigger (fixed in 0095) still
--      treated these as active, potentially blocking new inserts.  Mark them
--      completed_rental so they no longer block future bookings.
--
--   2. The stuck booking bk-bc8b0ddcc89e was never persisted because the pipeline
--      failed before completing.  Insert it directly so the renter has a record,
--      the vehicle shows as unavailable, and revenue is recorded.
--
--   3. The reconciliation dedup state in app_config retains pi_3TQwKHPo7fICjrtZ18v5heUr
--      in its 25-hour dedup window, preventing future auto-repair attempts.
--      Remove it so the next cron run can re-check (and will find the revenue
--      record inserted here, confirming it is resolved).
--
-- Safe to re-run: all writes are idempotent (ON CONFLICT DO UPDATE / DO NOTHING,
-- UPDATE with IS DISTINCT FROM guard, DELETE is always safe to re-run).

DO $$
DECLARE
  v_customer_id uuid;
BEGIN

  -- ── 1. Mark stale camry2013 active_rental bookings as completed_rental ──────
  -- bk-bb-2026-0407 (Brandon Bookhart, return 2026-04-12) and
  -- bk-c0c7138a5d2a  (Brandon Bookhart, return 2026-04-26/27 with extension)
  -- have been sitting as active_rental long past their return dates.

  UPDATE public.bookings
  SET    status      = 'completed_rental',
         completed_at = COALESCE(completed_at, return_date::timestamptz),
         updated_at  = now()
  WHERE  booking_ref IN ('bk-bb-2026-0407', 'bk-c0c7138a5d2a')
    AND  status = 'active_rental';

  -- Also mark any other camry2013 bookings that are still non-cancelled /
  -- non-completed but whose return_date is more than 2 days in the past.
  UPDATE public.bookings
  SET    status      = 'completed_rental',
         completed_at = COALESCE(completed_at, return_date::timestamptz),
         updated_at  = now()
  WHERE  vehicle_id   = 'camry2013'
    AND  return_date  < (CURRENT_DATE - INTERVAL '2 days')
    AND  status NOT IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental');

  -- Do the same for camry (2012) to keep both vehicles clean.
  UPDATE public.bookings
  SET    status      = 'completed_rental',
         completed_at = COALESCE(completed_at, return_date::timestamptz),
         updated_at  = now()
  WHERE  vehicle_id   = 'camry'
    AND  return_date  < (CURRENT_DATE - INTERVAL '2 days')
    AND  status NOT IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental');

  -- ── 2. Upsert customer: Brandon Bookhart ────────────────────────────────────
  INSERT INTO public.customers (name, phone, email, updated_at)
  VALUES ('Brandon Bookhart', '+15303285561', 'brandon.bookhart@gmail.com', now())
  ON CONFLICT (phone) DO UPDATE
    SET name       = EXCLUDED.name,
        email      = COALESCE(EXCLUDED.email, customers.email),
        updated_at = now()
  RETURNING id INTO v_customer_id;

  IF v_customer_id IS NULL THEN
    SELECT id INTO v_customer_id
    FROM   public.customers
    WHERE  phone = '+15303285561';
  END IF;

  -- ── 3. Insert stuck booking bk-bc8b0ddcc89e ─────────────────────────────────
  -- Payment: $60.64 full_payment, 2026-04-27 → 2026-04-28, camry2013.
  -- PI: pi_3TQwKHPo7fICjrtZ18v5heUr
  -- Pickup was 08:00 on 2026-04-27 (already past), so status is active_rental.
  INSERT INTO public.bookings (
    booking_ref, customer_id, vehicle_id,
    pickup_date, return_date,
    pickup_time, return_time,
    status, total_price, deposit_paid, remaining_balance,
    payment_status, payment_method,
    payment_intent_id, stripe_customer_id,
    customer_name, customer_email, customer_phone,
    notes, updated_at
  )
  VALUES (
    'bk-bc8b0ddcc89e', v_customer_id, 'camry2013',
    '2026-04-27', '2026-04-28',
    '08:00:00', '08:00:00',
    'active_rental', 60.64, 60.64, 0.00,
    'paid', 'stripe',
    'pi_3TQwKHPo7fICjrtZ18v5heUr', 'cus_UKU6OFbaET2wdh',
    'Brandon Bookhart', 'brandon.bookhart@gmail.com', '+15303285561',
    'Full payment $60.64 via Stripe. 1-day rental. Backfilled via migration 0097.',
    now()
  )
  ON CONFLICT (booking_ref) DO UPDATE
    -- Only upgrade the status (never downgrade a terminal state).
    SET status = CASE
          WHEN bookings.status IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental')
          THEN bookings.status
          ELSE 'active_rental'
        END,
        total_price        = EXCLUDED.total_price,
        deposit_paid       = EXCLUDED.deposit_paid,
        remaining_balance  = EXCLUDED.remaining_balance,
        payment_status     = EXCLUDED.payment_status,
        payment_intent_id  = COALESCE(EXCLUDED.payment_intent_id, bookings.payment_intent_id),
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, bookings.stripe_customer_id),
        customer_id        = COALESCE(EXCLUDED.customer_id, bookings.customer_id),
        updated_at         = now();

  -- ── 4. Insert revenue record for bk-bc8b0ddcc89e ────────────────────────────
  INSERT INTO public.revenue_records (
    booking_id, payment_intent_id, vehicle_id,
    customer_id, customer_name, customer_phone, customer_email,
    pickup_date, return_date,
    gross_amount, refund_amount,
    payment_method, payment_status, type,
    stripe_fee,
    notes
  )
  VALUES (
    'bk-bc8b0ddcc89e', 'pi_3TQwKHPo7fICjrtZ18v5heUr', 'camry2013',
    v_customer_id, 'Brandon Bookhart', '+15303285561', 'brandon.bookhart@gmail.com',
    '2026-04-27', '2026-04-28',
    60.64, 0.00,
    'stripe', 'paid', 'rental',
    NULL,   -- stripe_fee: stripe-reconcile.js will backfill after settlement
    'Full payment $60.64. 1-day rental. Backfilled via migration 0097.'
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
    SET payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, revenue_records.payment_intent_id),
        gross_amount      = EXCLUDED.gross_amount,
        stripe_fee        = COALESCE(EXCLUDED.stripe_fee, revenue_records.stripe_fee),
        updated_at        = now();

  -- ── 5. Insert blocked_dates for bk-bc8b0ddcc89e ─────────────────────────────
  -- Buffer: return_time 08:00 + PICKUP_BUFFER_HOURS(2) = 10:00
  INSERT INTO public.blocked_dates (
    vehicle_id, start_date, end_date, end_time, reason, booking_ref
  )
  VALUES (
    'camry2013', '2026-04-27', '2026-04-28', '10:00:00', 'booking', 'bk-bc8b0ddcc89e'
  )
  ON CONFLICT (vehicle_id, start_date, end_date, reason)
  DO UPDATE SET
    end_time    = COALESCE(EXCLUDED.end_time, blocked_dates.end_time),
    booking_ref = COALESCE(EXCLUDED.booking_ref, blocked_dates.booking_ref),
    updated_at  = now();

  -- ── 6. Remove stuck PI from reconciliation dedup state ──────────────────────
  -- Removes pi_3TQwKHPo7fICjrtZ18v5heUr from the alertedPIs map so the next
  -- cron run re-checks it and finds the revenue record inserted above (resolved).
  UPDATE public.app_config
  SET    value = (value - 'pi_3TQwKHPo7fICjrtZ18v5heUr')
  WHERE  key   = 'reconciliation_alerted_pi_ids'
    AND  value ? 'pi_3TQwKHPo7fICjrtZ18v5heUr';

END $$;
