-- Migration 0043: add payment_intent_id to revenue_records
--
-- The reconciliation check in scheduled-reminders.js matches succeeded Stripe
-- PaymentIntents against revenue_records using two strategies:
--   1. payment_intent_id column (this migration)
--   2. booking_id column = PI id (extension records already use this)
--
-- Without this column, strategy 1 returned a Supabase error (silently dropped),
-- leaving recordedPIIds always empty and causing repeat reconciliation alerts
-- every 15-minute cron tick for up to 24 hours per payment.
--
-- The column is nullable:
--   • Rows for Stripe bookings set it to the PaymentIntent id.
--   • Extension rows leave it NULL (their booking_id IS the PI id — strategy 2).
--   • Manual/cash rows leave it NULL.

alter table revenue_records
  add column if not exists payment_intent_id text default null;

create index if not exists revenue_records_payment_intent_id_idx
  on revenue_records (payment_intent_id)
  where payment_intent_id is not null;
