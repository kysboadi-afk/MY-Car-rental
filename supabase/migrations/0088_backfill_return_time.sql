-- Backfill return_time for bookings where it is NULL.
-- Use pickup_time when available (keeps the same daily window); fall back to
-- 10:00 AM (DEFAULT_RETURN_TIME in _time.js) as a safe general default.
-- This ensures all SMS cron jobs receive a valid return_time and can compute
-- minutesToReturn correctly.

UPDATE bookings
SET    return_time = COALESCE(pickup_time, '10:00:00')
WHERE  return_time IS NULL;
