-- Migration 0137: Add ID back-side columns to pending_booking_docs
--
-- Purpose: store the renter's ID back photo alongside the front so both
-- are attached to the owner notification email when a booking is confirmed.
--
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards.

ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS id_back_base64   text,
  ADD COLUMN IF NOT EXISTS id_back_filename text,
  ADD COLUMN IF NOT EXISTS id_back_mimetype text;
