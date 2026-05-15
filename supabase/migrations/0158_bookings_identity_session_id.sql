-- Migration 0158: ensure bookings.identity_session_id exists
--
-- Required for Stripe Identity-aware booking health checks and booking flows
-- that persist Stripe verification session IDs on the bookings table.

ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS identity_session_id text;
