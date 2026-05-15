-- Migration 0105: Slingshot vehicles are kept in the fleet.
-- The original DELETE has been reverted — slingshot units remain active.
-- No-op: this migration is intentionally left as a comment-only statement
-- so that the migration sequence remains intact for existing databases.
SELECT 1 WHERE false; -- no-op
