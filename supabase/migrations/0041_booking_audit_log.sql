-- Migration 0041: booking audit log
-- Tracks every meaningful change to a booking (status, dates, price) so
-- discrepancies can be identified quickly without full-table scans.
--
-- Columns:
--   id           — surrogate PK
--   booking_ref  — matches bookings.booking_ref (and bookings.json bookingId)
--   changed_by   — who/what made the change ("stripe-webhook", "admin", etc.)
--   changed_at   — UTC timestamp of the change
--   field        — which field changed ("status", "return_date", "total_price", …)
--   old_value    — previous value as text (nullable for inserts)
--   new_value    — new value as text

create table if not exists booking_audit_log (
  id          bigserial primary key,
  booking_ref text        not null,
  changed_by  text        not null default 'system',
  changed_at  timestamptz not null default now(),
  field       text        not null,
  old_value   text,
  new_value   text
);

-- Index for fast lookup by booking
create index if not exists booking_audit_log_ref_idx
  on booking_audit_log (booking_ref, changed_at desc);
