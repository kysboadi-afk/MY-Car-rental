-- 0020_bouncie_tracking.sql
-- Bouncie GPS integration: vehicle mileage tracking and trip history.
--
-- Tables:
--   vehicle_mileage — one row per vehicle: current odometer, last service mark, sync timestamp
--   trip_log        — one row per trip: distance, speed, hard braking, odometer at end
--
-- Safe to re-run: all statements use IF NOT EXISTS / CREATE OR REPLACE guards.

-- ── vehicle_mileage ──────────────────────────────────────────────────────────
create table if not exists vehicle_mileage (
  vehicle_id            text          primary key,
  bouncie_imei          text          unique,
  total_mileage         numeric(10,1) not null default 0,
  last_service_mileage  numeric(10,1) not null default 0,  -- updated manually after each service visit
  last_trip_at          timestamptz,
  last_synced_at        timestamptz   not null default now(),
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now()
);

create index if not exists vehicle_mileage_imei_idx on vehicle_mileage (bouncie_imei);

-- Auto-update updated_at
create or replace function update_vehicle_mileage_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vehicle_mileage_updated_at on vehicle_mileage;
create trigger vehicle_mileage_updated_at
  before update on vehicle_mileage
  for each row execute function update_vehicle_mileage_updated_at();

-- ── trip_log ─────────────────────────────────────────────────────────────────
create table if not exists trip_log (
  id              bigserial     primary key,
  vehicle_id      text          not null,
  bouncie_imei    text          not null,
  transaction_id  text          unique,            -- Bouncie transactionId — deduplication key
  trip_distance   numeric(8,2),                    -- miles
  start_odometer  numeric(10,1),
  end_odometer    numeric(10,1),
  trip_time_secs  integer,
  max_speed_mph   numeric(5,1),
  hard_braking    integer       not null default 0,
  hard_accel      integer       not null default 0,
  trip_at         timestamptz   not null,
  source          text          not null default 'webhook', -- 'webhook' | 'sync'
  created_at      timestamptz   not null default now()
);

create index if not exists trip_log_vehicle_idx on trip_log (vehicle_id);
create index if not exists trip_log_trip_at_idx on trip_log (trip_at desc);
create index if not exists trip_log_tx_idx      on trip_log (transaction_id);
