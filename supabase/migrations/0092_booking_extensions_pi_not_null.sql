-- Migration 0092: enforce payment_intent_id NOT NULL on booking_extensions
--
-- payment_intent_id already carries a UNIQUE constraint (migration 0080) which
-- is the idempotency key for extension upserts.  A NULL value in a UNIQUE column
-- is not comparable to other NULLs in Postgres, so multiple NULL rows are
-- permitted — silently bypassing the dedup guard.
--
-- This migration closes that gap by adding NOT NULL so every extension row is
-- provably traceable to a Stripe PaymentIntent.
--
-- Safe to run: all existing rows inserted by the application always carry a
-- non-null payment_intent_id (enforced at the application layer since 0080).
-- The backfill in 0080 also filters rr.payment_intent_id IS NOT NULL.

ALTER TABLE booking_extensions
  ALTER COLUMN payment_intent_id SET NOT NULL;
