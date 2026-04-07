-- =============================================================================
-- SLY RIDES — Migration 0036: Extra charges table
-- =============================================================================
--
-- Stores every extra charge applied to a booking (damages, late fees, key
-- replacement, smoking penalties, etc.) via the Admin UI or AI assistant.
--
-- Each row records:
--   booking_id               — booking_ref from the bookings table
--   charge_type              — key_replacement | smoking | late_fee | custom
--   amount                   — USD amount charged
--   notes                    — optional admin note or description
--   stripe_payment_intent_id — Stripe PI id for the off-session charge
--   status                   — pending | succeeded | failed
--   charged_by               — "admin" (UI button) | "ai" (AI assistant)
--   error_message            — Stripe error reason when status = failed
--   created_at               — timestamp
-- =============================================================================

CREATE TABLE IF NOT EXISTS charges (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                text        NOT NULL,
  charge_type               text        NOT NULL CHECK (charge_type IN ('key_replacement','smoking','late_fee','custom')),
  amount                    numeric(10,2) NOT NULL CHECK (amount > 0),
  notes                     text,
  stripe_payment_intent_id  text,
  status                    text        NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending','succeeded','failed')),
  charged_by                text        NOT NULL DEFAULT 'admin'
                                        CHECK (charged_by IN ('admin','ai')),
  error_message             text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS charges_booking_id_idx
  ON charges (booking_id);

CREATE INDEX IF NOT EXISTS charges_created_at_idx
  ON charges (created_at DESC);
