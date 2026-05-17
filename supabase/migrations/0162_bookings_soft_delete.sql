-- 0162_bookings_soft_delete.sql
-- Adds reversible soft-delete metadata for bookings so admin deletes are recoverable.

alter table public.bookings
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add column if not exists deleted_reason text;

create index if not exists idx_bookings_deleted_at
  on public.bookings (deleted_at);

create index if not exists idx_bookings_active_lookup
  on public.bookings (vehicle_id, status, created_at desc)
  where deleted_at is null;
