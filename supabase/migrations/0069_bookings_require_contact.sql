-- 0069_bookings_require_contact.sql
--
-- Adds a CHECK constraint that requires every booking row to have at least one
-- contact identifier (customer_phone OR customer_email).  This prevents silent
-- data-loss bugs where a booking is created without any way for the customer to
-- later retrieve it via manage-booking.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ SAFETY — read before deploying                                          │
-- │                                                                         │
-- │ Step A — audit first.  Run this query and confirm it returns 0 before   │
-- │ promoting the constraint to VALIDATED:                                  │
-- │                                                                         │
-- │   SELECT COUNT(*)                                                        │
-- │   FROM public.bookings                                                   │
-- │   WHERE customer_phone IS NULL                                           │
-- │     AND customer_email IS NULL;                                          │
-- │                                                                         │
-- │ If the count > 0, backfill via:                                         │
-- │   POST /api/stripe-backfill  { backfill_contacts: true }                │
-- │                                                                         │
-- │ Step B — validate once clean.  After the audit returns 0, run:          │
-- │   ALTER TABLE public.bookings                                           │
-- │     VALIDATE CONSTRAINT bookings_require_contact;                       │
-- │                                                                         │
-- │ The constraint is added NOT VALID so it does NOT scan existing rows     │
-- │ now — it only guards new INSERTs and UPDATEs immediately.               │
-- └─────────────────────────────────────────────────────────────────────────┘

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname    = 'bookings_require_contact'
      AND conrelid   = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_require_contact
      CHECK (customer_phone IS NOT NULL OR customer_email IS NOT NULL)
      NOT VALID;

    RAISE NOTICE 'bookings_require_contact constraint added (NOT VALID). '
                 'Run VALIDATE CONSTRAINT after backfilling all existing rows.';
  ELSE
    RAISE NOTICE 'bookings_require_contact constraint already exists — skipping.';
  END IF;
END $$;
