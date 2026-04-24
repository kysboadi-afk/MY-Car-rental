-- Migration 0070: Add protection plan columns to bookings
--
-- Purpose: track whether a booking includes the Damage Protection Plan (DPP)
-- and which tier was selected so that manage-booking can pre-fill the edit form
-- and so that apply_change / booking_change_fee correctly reflect the customer's
-- current coverage choice.
--
-- New columns on bookings:
--   has_protection_plan  — true when the booking includes DPP
--   protection_plan_tier — 'basic', 'standard', or 'premium' (null when no DPP)
--
-- Safe to re-run: all statements use IF NOT EXISTS guards.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS has_protection_plan  boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS protection_plan_tier text;
