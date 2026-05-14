-- Migration 0149: Customer identity backfill — Phase B supporting indexes
--
-- PHASE B: Additive index-only migration. Zero behavior changes.
--
-- Adds indexes on bookings and customers needed for efficient Phase B
-- identity-matching queries. No new tables are created; Phase A (0148)
-- already created all necessary tables.
--
-- Safe to re-run: every DDL is guarded with IF NOT EXISTS.

-- ── 1. bookings — phone matching index ───────────────────────────────────────
--
-- Phase B matches bookings against customers via customer_phone.
-- The column exists (added via earlier migrations) but has no general index.

CREATE INDEX IF NOT EXISTS bookings_customer_phone_idx
  ON bookings (customer_phone)
  WHERE customer_phone IS NOT NULL;

-- ── 2. bookings — identity backfill cursor index ─────────────────────────────
--
-- Allows the backfill to page through unlinked bookings efficiently using
-- booking_ref as the stable sort key / resume cursor.

CREATE INDEX IF NOT EXISTS bookings_identity_cursor_idx
  ON bookings (booking_ref)
  WHERE booking_ref IS NOT NULL;

-- ── 3. customers — normalized phone lookup index ──────────────────────────────
--
-- Populated during Phase B normalize_customers pass. Used by exact_phone tier.
-- Phase A (0148) already creates this index; this statement is a no-op if
-- 0148 ran first but is idempotent either way.

CREATE INDEX IF NOT EXISTS customers_normalized_phone_idx
  ON customers (normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- ── 4. customers — normalized email lookup index ──────────────────────────────

CREATE INDEX IF NOT EXISTS customers_normalized_email_idx
  ON customers (normalized_email)
  WHERE normalized_email IS NOT NULL;

-- ── 5. customers — Stripe customer ID lookup ──────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_customer_id_idx
  ON customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── 6. customer_migration_log — idempotency guard index ───────────────────────
--
-- Allows the backfill to quickly check if a booking_ref has already been
-- processed without a full table scan.

CREATE UNIQUE INDEX IF NOT EXISTS customer_migration_log_booking_ref_action_idx
  ON customer_migration_log (booking_ref, action)
  WHERE booking_ref IS NOT NULL;
