-- Migration 0045: add sync_excluded to revenue_records
--
-- When an admin deletes a revenue record that was auto-synced from a booking,
-- we soft-delete it (sync_excluded = true) instead of hard-deleting it.
-- This prevents the "Sync from Bookings" action from recreating the record on
-- every subsequent sync, because it checks booking_id existence across ALL rows
-- (including sync_excluded ones) before inserting.

alter table revenue_records
  add column if not exists sync_excluded boolean not null default false;

create index if not exists revenue_records_sync_excluded_idx
  on revenue_records (sync_excluded)
  where sync_excluded = true;
