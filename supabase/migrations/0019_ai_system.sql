-- 0019_ai_system.sql
-- AI Admin Assistant — Supabase schema additions.
--
-- 1. ai_logs table          — full audit trail of every AI tool execution
-- 2. flagged / risk_score   — fraud detection columns on bookings
-- 3. SQL analytics functions — optimised read-only helpers called via RPC

-- ── 1. ai_logs ──────────────────────────────────────────────────────────────
create table if not exists ai_logs (
  id         bigserial    primary key,
  action     text         not null,
  input      jsonb,
  output     jsonb,
  admin_id   text,
  created_at timestamptz  not null default now()
);

create index if not exists ai_logs_action_idx     on ai_logs (action);
create index if not exists ai_logs_created_at_idx on ai_logs (created_at desc);

-- ── 2. Fraud columns on bookings ─────────────────────────────────────────────
alter table bookings
  add column if not exists flagged    boolean not null default false,
  add column if not exists risk_score integer not null default 0;

create index if not exists bookings_flagged_idx on bookings (flagged) where flagged = true;

-- ── 3. SQL analytics functions ───────────────────────────────────────────────

-- Monthly revenue from revenue_records
create or replace function get_monthly_revenue(month_input text)
returns numeric
language sql
security invoker
as $$
  select coalesce(sum(gross_amount), 0)
  from   revenue_records
  where  to_char(created_at, 'YYYY-MM') = month_input
    and  (payment_status = 'paid' or payment_status is null)
    and  (is_cancelled is null or is_cancelled = false);
$$;

-- Booking count per vehicle (paid/active/completed)
create or replace function get_vehicle_booking_counts()
returns table(vehicle_id text, booking_count bigint)
language sql
security invoker
as $$
  select vehicle_id, count(*) as booking_count
  from   bookings
  where  status in ('approved', 'active', 'completed')
  group  by vehicle_id;
$$;

-- Bookings created in the last N days
create or replace function get_recent_booking_count(days_back integer default 3)
returns bigint
language sql
security invoker
as $$
  select count(*)
  from   bookings
  where  created_at >= now() - (days_back || ' days')::interval;
$$;

-- Revenue trend: last N months, grouped by month
create or replace function get_revenue_trend(months_back integer default 12)
returns table(month text, total numeric, booking_count bigint)
language sql
security invoker
as $$
  select
    to_char(created_at, 'YYYY-MM')      as month,
    coalesce(sum(gross_amount), 0)       as total,
    count(*)                             as booking_count
  from   revenue_records
  where  created_at >= date_trunc('month', now()) - ((months_back - 1) || ' months')::interval
    and  (payment_status = 'paid' or payment_status is null)
    and  (is_cancelled is null or is_cancelled = false)
  group  by to_char(created_at, 'YYYY-MM')
  order  by month asc;
$$;
