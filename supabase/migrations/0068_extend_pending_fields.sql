-- Migration 0068: Extension-pending fields on bookings
--
-- Migrates the extendPending and extensionPendingPayment booking fields
-- from bookings.json (GitHub) to the Supabase bookings table so they are
-- durable, queryable, and not dependent on the GitHub file store.
--
-- New columns on bookings:
--   extend_pending              — true while the customer has sent EXTEND but
--                                  not yet selected an option; cleared on
--                                  option selection or payment confirmation.
--   extension_pending_payment   — JSONB snapshot of the selected extension
--                                  option (price, label, newReturnDate, etc.)
--                                  while Stripe payment is outstanding; null
--                                  once the payment succeeds or is abandoned.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extend_pending            boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extension_pending_payment jsonb;

-- Fast lookup: find all bookings awaiting an extend-option reply.
CREATE INDEX IF NOT EXISTS bookings_extend_pending_idx
  ON bookings (extend_pending)
  WHERE extend_pending = true;
