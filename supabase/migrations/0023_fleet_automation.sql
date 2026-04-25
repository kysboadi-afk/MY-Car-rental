-- 0023_fleet_automation.sql
-- Fleet automation: maintenance history log + booking maintenance status.
--
-- New table:
--   maintenance_history — one row per completed service event (oil / brakes / tires).
--     Records the odometer reading at the time of service, which service type was
--     performed, and optionally the booking active at that time.
--
-- New column on bookings:
--   maintenance_status — tracks driver compliance when maintenance is overdue.
--     Values: NULL (normal) | 'non_compliant' (escalation triggered)
--
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ── maintenance_history ──────────────────────────────────────────────────────
create table if not exists maintenance_history (
  id           bigserial     primary key,
  vehicle_id   text          not null,
  service_type text          not null,   -- 'oil' | 'brakes' | 'tires'
  mileage      numeric(10,0) not null,   -- odometer reading at time of service
  notes        text,
  booking_id   text,                     -- active booking at time of service (nullable)
  created_at   timestamptz   not null default now()
);

create index if not exists maint_history_vehicle_idx on maintenance_history (vehicle_id);
create index if not exists maint_history_created_idx on maintenance_history (created_at desc);
create index if not exists maint_history_type_idx    on maintenance_history (service_type);

-- ── bookings maintenance_status column ───────────────────────────────────────
alter table bookings
  add column if not exists maintenance_status text;
-- values: NULL (normal) | 'non_compliant' (escalation triggered by 48h rule)
