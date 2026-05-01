-- Migration 0117: add rental-balance waiver fields to bookings
-- Mirrors the late_fee_waived* pattern so admins can waive the remaining
-- base-rental balance in addition to (or instead of) the late-fee penalty.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived        BOOLEAN     DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_amount NUMERIC     DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_reason TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_by     TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_at     TIMESTAMPTZ;

COMMENT ON COLUMN bookings.rental_balance_waived        IS 'True when an admin has applied a full or partial waiver to the remaining rental balance.';
COMMENT ON COLUMN bookings.rental_balance_waived_amount IS 'USD amount waived from the remaining balance. For a full waiver this equals the remaining_balance at the time of waiver; for a partial waiver it is the custom amount.';
COMMENT ON COLUMN bookings.rental_balance_waived_reason IS 'Mandatory reason supplied by the admin (e.g. "accident", "financial hardship").';
COMMENT ON COLUMN bookings.rental_balance_waived_by     IS 'Admin identifier who applied the waiver.';
COMMENT ON COLUMN bookings.rental_balance_waived_at     IS 'Timestamp when the waiver was applied.';
