-- 0027_maintenance_appointments.sql
-- Driver-driven maintenance scheduling.
--
-- When a maintenance alert is sent to a driver (80% / 100% threshold), the SMS
-- now includes a link to the scheduling page (/maintenance-schedule).  The driver
-- picks a date and time which is stored here.
--
-- Status lifecycle:
--   pending_approval — appointment created; awaiting owner approval
--                      (only used when MAINTENANCE_APPROVAL_MODE=approval)
--   scheduled        — appointment confirmed (auto or owner-approved)
--   completed        — service has been performed (future use)
--   cancelled        — appointment cancelled by owner or system
--
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

create table if not exists maintenance_appointments (
  id            bigserial     primary key,
  vehicle_id    text          not null,
  booking_id    text,                        -- active booking when appointment was made (nullable)
  service_type  text          not null,      -- 'oil' | 'brakes' | 'tires'
  scheduled_at  timestamptz   not null,      -- driver-chosen appointment date/time
  status        text          not null default 'scheduled',
                                             -- 'pending_approval' | 'scheduled' | 'completed' | 'cancelled'
  notes         text,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create index if not exists maint_appts_vehicle_idx    on maintenance_appointments (vehicle_id);
create index if not exists maint_appts_status_idx     on maintenance_appointments (status);
create index if not exists maint_appts_scheduled_idx  on maintenance_appointments (scheduled_at desc);
create index if not exists maint_appts_created_idx    on maintenance_appointments (created_at desc);
