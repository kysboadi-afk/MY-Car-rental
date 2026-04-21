-- Migration 0055: atomic booking + revenue upsert transaction
--
-- Guarantees booking + revenue persistence is all-or-nothing in a single DB
-- transaction for strict Stripe webhook processing.

CREATE OR REPLACE FUNCTION public.upsert_booking_revenue_atomic(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_booking_ref text,
  p_vehicle_id text,
  p_pickup_date date,
  p_return_date date,
  p_pickup_time time,
  p_return_time time,
  p_status text,
  p_total_price numeric,
  p_deposit_paid numeric,
  p_remaining_balance numeric,
  p_payment_status text,
  p_notes text,
  p_payment_method text,
  p_payment_intent_id text,
  p_stripe_customer_id text,
  p_stripe_payment_method_id text,
  p_booking_customer_email text,
  p_activated_at timestamptz,
  p_completed_at timestamptz,
  p_revenue_vehicle_id text,
  p_revenue_customer_name text,
  p_revenue_customer_phone text,
  p_revenue_customer_email text,
  p_revenue_pickup_date date,
  p_revenue_return_date date,
  p_gross_amount numeric,
  p_stripe_fee numeric,
  p_payment_intent_id_revenue text,
  p_refund_amount numeric,
  p_revenue_payment_method text,
  p_revenue_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer_id uuid;
  v_booking_id uuid;
  v_revenue_id uuid;
  v_revenue_stripe_fee numeric;
  v_revenue_payment_intent text;
BEGIN
  IF p_booking_ref IS NULL OR btrim(p_booking_ref) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  IF p_revenue_vehicle_id IS NULL OR btrim(p_revenue_vehicle_id) = '' THEN
    RAISE EXCEPTION 'revenue vehicle_id is required';
  END IF;

  -- Customer dedupe: email-first (primary identity), then phone fallback.
  IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE lower(c.email) = lower(p_customer_email)
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE c.phone = p_customer_phone
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND (
    (p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '') OR
    (p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '')
  ) THEN
    BEGIN
      INSERT INTO customers (
        name, phone, email, updated_at
      ) VALUES (
        COALESCE(NULLIF(p_customer_name, ''), 'Unknown'),
        NULLIF(p_customer_phone, ''),
        NULLIF(lower(p_customer_email), ''),
        now()
      )
      RETURNING id INTO v_customer_id;
    EXCEPTION
      WHEN unique_violation THEN
        IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE lower(c.email) = lower(p_customer_email)
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE c.phone = p_customer_phone
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET
      name = COALESCE(NULLIF(p_customer_name, ''), customers.name),
      phone = COALESCE(NULLIF(p_customer_phone, ''), customers.phone),
      email = COALESCE(NULLIF(lower(p_customer_email), ''), customers.email),
      updated_at = now()
    WHERE id = v_customer_id;
  END IF;

  INSERT INTO bookings (
    booking_ref,
    customer_id,
    vehicle_id,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    status,
    total_price,
    deposit_paid,
    remaining_balance,
    payment_status,
    notes,
    payment_method,
    payment_intent_id,
    stripe_customer_id,
    stripe_payment_method_id,
    customer_email,
    activated_at,
    completed_at
  ) VALUES (
    p_booking_ref,
    v_customer_id,
    p_vehicle_id,
    p_pickup_date,
    p_return_date,
    p_pickup_time,
    p_return_time,
    COALESCE(NULLIF(p_status, ''), 'pending'),
    COALESCE(p_total_price, 0),
    COALESCE(p_deposit_paid, 0),
    COALESCE(p_remaining_balance, 0),
    COALESCE(NULLIF(p_payment_status, ''), 'unpaid'),
    p_notes,
    p_payment_method,
    p_payment_intent_id,
    p_stripe_customer_id,
    p_stripe_payment_method_id,
    p_booking_customer_email,
    p_activated_at,
    p_completed_at
  )
  ON CONFLICT (booking_ref) DO UPDATE
  SET
    customer_id = EXCLUDED.customer_id,
    vehicle_id = EXCLUDED.vehicle_id,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    pickup_time = EXCLUDED.pickup_time,
    return_time = EXCLUDED.return_time,
    status = EXCLUDED.status,
    total_price = EXCLUDED.total_price,
    deposit_paid = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    payment_method = EXCLUDED.payment_method,
    payment_intent_id = EXCLUDED.payment_intent_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_payment_method_id = EXCLUDED.stripe_payment_method_id,
    customer_email = EXCLUDED.customer_email,
    activated_at = COALESCE(EXCLUDED.activated_at, bookings.activated_at),
    completed_at = COALESCE(EXCLUDED.completed_at, bookings.completed_at),
    updated_at = now()
  RETURNING id INTO v_booking_id;

  INSERT INTO revenue_records (
    booking_id,
    payment_intent_id,
    vehicle_id,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    pickup_date,
    return_date,
    gross_amount,
    refund_amount,
    payment_method,
    payment_status,
    type,
    notes,
    stripe_fee
  ) VALUES (
    p_booking_ref,
    p_payment_intent_id_revenue,
    p_revenue_vehicle_id,
    v_customer_id,
    p_revenue_customer_name,
    p_revenue_customer_phone,
    p_revenue_customer_email,
    p_revenue_pickup_date,
    p_revenue_return_date,
    COALESCE(p_gross_amount, 0),
    COALESCE(p_refund_amount, 0),
    COALESCE(NULLIF(p_revenue_payment_method, ''), 'stripe'),
    'paid',
    'rental',
    p_revenue_notes,
    p_stripe_fee
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
  SET
    payment_intent_id = EXCLUDED.payment_intent_id,
    vehicle_id = EXCLUDED.vehicle_id,
    customer_id = EXCLUDED.customer_id,
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    customer_email = EXCLUDED.customer_email,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    gross_amount = EXCLUDED.gross_amount,
    refund_amount = EXCLUDED.refund_amount,
    payment_method = EXCLUDED.payment_method,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    stripe_fee = EXCLUDED.stripe_fee,
    updated_at = now()
  RETURNING id, stripe_fee, payment_intent_id
  INTO v_revenue_id, v_revenue_stripe_fee, v_revenue_payment_intent;

  IF v_revenue_stripe_fee IS NULL OR v_revenue_payment_intent IS NULL OR btrim(v_revenue_payment_intent) = '' THEN
    RAISE EXCEPTION 'revenue record incomplete after upsert for booking_ref=%', p_booking_ref;
  END IF;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'customer_id', v_customer_id,
    'revenue_id', v_revenue_id,
    'revenue_complete', true
  );
END;
$$;
