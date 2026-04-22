# Supabase Assistant Prompt — SLY RIDES Booking System

Copy the block below and paste it into the Supabase AI / MCP assistant to set up or
verify the full rental-management database for SLY RIDES.

Booking data quality rule: always capture and persist both `pickup_time` and `return_time` for every booking; treat missing booking times as an integrity issue that must be corrected.

---

```
I'm building a car-rental management system called SLY RIDES.
My Supabase project needs the following database schema and automation.
Please apply each section in order, using ADD COLUMN IF NOT EXISTS and
CREATE OR REPLACE wherever possible so the script is safe to re-run.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. VEHICLES TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
One row per vehicle. vehicle_id is the text key used throughout the codebase
(e.g. "slingshot", "slingshot2", "slingshot3", "camry", "camry2013").

CREATE TABLE IF NOT EXISTS vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    text UNIQUE NOT NULL,
  vehicle_name  text,
  type          text CHECK (type IN ('slingshot','economy')),
  data          jsonb DEFAULT '{}',
  rental_status text NOT NULL DEFAULT 'available'
                  CHECK (rental_status IN ('available','reserved','rented','maintenance')),
  daily_price   numeric(10,2),
  mileage       integer,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','maintenance','inactive')),
  cover_image   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

Seed the five vehicles if they do not already exist:

INSERT INTO vehicles (vehicle_id, vehicle_name, type, status)
VALUES
  ('slingshot',  'Slingshot R',         'slingshot', 'active'),
  ('slingshot2', 'Slingshot R (Unit 2)','slingshot', 'active'),
  ('slingshot3', 'Slingshot R (Unit 3)','slingshot', 'active'),
  ('camry',      'Camry 2012',          'economy',   'active'),
  ('camry2013',  'Camry 2013 SE',       'economy',   'active')
ON CONFLICT (vehicle_id) DO NOTHING;

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. CUSTOMERS TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Keyed by phone number. Aggregates are updated by triggers.

CREATE TABLE IF NOT EXISTS customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          text UNIQUE NOT NULL,
  full_name      text,
  email          text,
  driver_license text,
  risk_flag      boolean NOT NULL DEFAULT false,
  total_bookings integer NOT NULL DEFAULT 0,
  total_spent    numeric(10,2) NOT NULL DEFAULT 0,
  no_show_count  integer NOT NULL DEFAULT 0
                   CONSTRAINT customers_no_show_count_non_negative CHECK (no_show_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. BOOKINGS TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
booking_ref maps 1-to-1 to the JS bookingId field in bookings.json.
remaining_balance is generated so it never drifts from total_price/deposit_paid.

CREATE TABLE IF NOT EXISTS bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref       text UNIQUE NOT NULL,
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id        text NOT NULL REFERENCES vehicles(vehicle_id) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','active','completed','cancelled')),
  pickup_date       date,
  return_date       date,
  pickup_time       time,
  return_time       time,
  total_price       numeric(10,2) NOT NULL DEFAULT 0,
  deposit_paid      numeric(10,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(10,2) GENERATED ALWAYS AS
                      (GREATEST(0, total_price - deposit_paid)) STORED,
  payment_status    text NOT NULL DEFAULT 'unpaid'
                      CHECK (payment_status IN ('unpaid','partial','paid')),
  payment_method    text,
  notes             text,
  activated_at      timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bookings_vehicle_id_idx    ON bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS bookings_customer_id_idx   ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS bookings_status_idx        ON bookings(status);
CREATE INDEX IF NOT EXISTS bookings_pickup_date_idx   ON bookings(pickup_date);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. BLOCKED_DATES TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mirrors booked-dates.json for Supabase-side availability queries.

CREATE TABLE IF NOT EXISTS blocked_dates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text NOT NULL,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  reason      text NOT NULL DEFAULT 'booking'
                CHECK (reason IN ('booking','maintenance','manual')),
  booking_ref text REFERENCES bookings(booking_ref) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blocked_dates_vehicle_idx ON blocked_dates(vehicle_id);
CREATE INDEX IF NOT EXISTS blocked_dates_range_idx   ON blocked_dates(vehicle_id, start_date, end_date);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. REVENUE_RECORDS TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Legacy revenue table — still written by autoCreateRevenueRecord.
net_amount is generated (gross minus any deposit that will be returned).

CREATE TABLE IF NOT EXISTS revenue_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      text,
  vehicle_id      text,
  customer_name   text,
  customer_phone  text,
  customer_email  text,
  pickup_date     date,
  return_date     date,
  gross_amount    numeric(10,2) NOT NULL DEFAULT 0,
  deposit_amount  numeric(10,2) NOT NULL DEFAULT 0,
  net_amount      numeric(10,2) GENERATED ALWAYS AS (gross_amount - deposit_amount) STORED,
  payment_method  text,
  status          text,
  notes           text,
  is_no_show      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS revenue_records_booking_id_idx
  ON revenue_records(booking_id) WHERE booking_id IS NOT NULL;

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. EXPENSES TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CREATE TABLE IF NOT EXISTS expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text,
  date        date NOT NULL,
  category    text NOT NULL,
  amount      numeric(10,2) NOT NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. SYSTEM_SETTINGS TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Key/value store for dynamic pricing, tax rates, and feature flags.

CREATE TABLE IF NOT EXISTS system_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    text NOT NULL,
  key         text NOT NULL,
  value       text NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, key)
);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. PROTECTION_PLANS TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CREATE TABLE IF NOT EXISTS protection_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key         text UNIQUE NOT NULL,
  plan_name        text NOT NULL,
  daily_rate       numeric(10,2) NOT NULL DEFAULT 0,
  liability_cap    numeric(10,2),
  description      text,
  is_active        boolean NOT NULL DEFAULT true,
  display_order    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. SMS_TEMPLATE_OVERRIDES TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CREATE TABLE IF NOT EXISTS sms_template_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key  text UNIQUE NOT NULL,
  body          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. TRIGGERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- 10a. Auto-stamp activated_at / completed_at on bookings ─────────────────
CREATE OR REPLACE FUNCTION on_booking_status_timestamps()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  CASE NEW.status
    WHEN 'active' THEN
      IF NEW.activated_at IS NULL THEN NEW.activated_at := now(); END IF;
    WHEN 'completed' THEN
      IF NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_status_timestamps ON bookings;
CREATE TRIGGER bookings_status_timestamps
  BEFORE INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_timestamps();

-- 10b. Keep vehicles.rental_status in sync with bookings.status ───────────
-- Status map:  pending→available, approved→reserved, active→rented,
--              completed→available, cancelled→available
CREATE OR REPLACE FUNCTION sync_vehicle_rental_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  new_rental_status text;
BEGIN
  new_rental_status := CASE NEW.status
    WHEN 'approved'  THEN 'reserved'
    WHEN 'active'    THEN 'rented'
    ELSE 'available'
  END;
  UPDATE vehicles
     SET rental_status = new_rental_status,
         updated_at    = now()
   WHERE vehicle_id = NEW.vehicle_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_booking_status_change ON bookings;
CREATE TRIGGER on_booking_status_change
  AFTER INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_vehicle_rental_status();

-- 10c. Keep customers.no_show_count in sync with revenue_records ──────────
CREATE OR REPLACE FUNCTION update_customer_no_show_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_phone text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_phone := OLD.customer_phone;
  ELSE
    v_phone := NEW.customer_phone;
  END IF;
  IF v_phone IS NULL OR v_phone = '' THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_no_show THEN
      UPDATE customers SET no_show_count = no_show_count + 1
       WHERE phone = v_phone;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT OLD.is_no_show AND NEW.is_no_show THEN
      UPDATE customers SET no_show_count = no_show_count + 1
       WHERE phone = v_phone;
    ELSIF OLD.is_no_show AND NOT NEW.is_no_show THEN
      UPDATE customers SET no_show_count = GREATEST(0, no_show_count - 1)
       WHERE phone = v_phone;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.is_no_show THEN
      UPDATE customers SET no_show_count = GREATEST(0, no_show_count - 1)
       WHERE phone = v_phone;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS on_revenue_no_show_change ON revenue_records;
CREATE TRIGGER on_revenue_no_show_change
  AFTER INSERT OR UPDATE OF is_no_show OR DELETE ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION update_customer_no_show_count();

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
11. ROW LEVEL SECURITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All tables are accessed exclusively by the service-role key from Vercel
serverless functions — RLS should be DISABLED on all rental tables so
the service role can read/write without policy interference.

ALTER TABLE vehicles          DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers         DISABLE ROW LEVEL SECURITY;
ALTER TABLE bookings          DISABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_dates     DISABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_records   DISABLE ROW LEVEL SECURITY;
ALTER TABLE expenses          DISABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings   DISABLE ROW LEVEL SECURITY;
ALTER TABLE protection_plans  DISABLE ROW LEVEL SECURITY;
ALTER TABLE sms_template_overrides DISABLE ROW LEVEL SECURITY;

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
12. VERIFICATION QUERIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After applying the above, run these to confirm everything is in place:

-- Check all required tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'vehicles','customers','bookings','blocked_dates',
    'revenue_records','expenses','system_settings',
    'protection_plans','sms_template_overrides'
  )
ORDER BY table_name;

-- Check all three triggers are installed
SELECT trigger_name, event_object_table, event_manipulation
FROM information_schema.triggers
WHERE trigger_name IN (
  'bookings_status_timestamps',
  'on_booking_status_change',
  'on_revenue_no_show_change'
)
ORDER BY trigger_name;

-- Check bookings has all required columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'bookings'
  AND table_schema = 'public'
ORDER BY ordinal_position;

-- Spot-check that the remaining_balance generated column exists
SELECT booking_ref, total_price, deposit_paid, remaining_balance
FROM bookings
LIMIT 5;
```

---

## Why this prompt is needed

The SLY RIDES backend keeps two sources of truth in sync:

| Source | Written by | Read by |
|--------|-----------|---------|
| `bookings.json` on GitHub | Every API endpoint that creates/updates bookings | Admin portal list view, availability checks |
| Supabase `bookings` table | `autoUpsertBooking()` in `_booking-automation.js` | Revenue Tracker, Customer Management, Analytics |

**The sync flow:**
1. A customer pays → `send-reservation-email.js` writes to `bookings.json` AND calls `autoUpsertBooking`
2. Stripe webhook fires → `stripe-webhook.js` updates `bookings.json` AND calls `autoUpsertBooking`
3. Admin approves/completes booking → `v2-bookings.js` updates `bookings.json` AND calls `autoUpsertBooking`
4. Admin adds manual booking → `add-manual-booking.js` writes to `bookings.json` AND calls `autoUpsertBooking`

If Supabase tables are missing or triggers are not installed, the `autoUpsertBooking` calls fail silently
(they are non-fatal), leaving the Revenue Tracker and Customer Management panels empty or stale.

Running the above schema ensures all Supabase sync operations succeed immediately.

## Environment variables required in Vercel

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL (e.g. `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS — keep secret) |
| `GITHUB_TOKEN` | **Required for all booking writes** (approve, cancel, manual booking). Without this, admin booking updates return 500. |
| `ADMIN_SECRET` | Admin portal password |
| `STRIPE_SECRET_KEY` | Stripe payments |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Confirmation emails |
| `TEXTMAGIC_USERNAME` / `TEXTMAGIC_API_KEY` | SMS notifications |

> **Note:** The most common cause of `500 Internal Server Error` on the admin portal's
> "Approve / Decline" buttons is a missing or expired `GITHUB_TOKEN`. Verify it is set
> correctly in the Vercel dashboard under Project → Settings → Environment Variables,
> then redeploy.
