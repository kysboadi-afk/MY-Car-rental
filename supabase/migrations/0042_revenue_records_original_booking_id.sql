-- Migration 0042: add original_booking_id to revenue_records
--
-- Extension payments are stored as separate revenue_records rows keyed to
-- the extension PaymentIntent ID.  This column links each extension row back
-- to the original booking so rollups, triggers, and reporting queries can
-- aggregate all revenue (initial + extensions) under one booking reference.
--
-- The column is nullable: rows for initial bookings leave it NULL.
-- Rows for extensions set it to the original booking's booking_ref / bookingId.

alter table revenue_records
  add column if not exists original_booking_id text default null;

-- Index for rollup queries: "give me all revenue rows for booking X"
-- (including extension rows where original_booking_id = X)
create index if not exists revenue_records_original_booking_id_idx
  on revenue_records (original_booking_id)
  where original_booking_id is not null;
