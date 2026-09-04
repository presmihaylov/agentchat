-- Rollback window only. Removes exactly what the up file created: the
-- accounts it inserted (their identities and sessions cascade) and the links
-- into them. Pre-linked and registered users, and rows the up file merged
-- into a pre-linked user, are untouched. Participants, rooms, agents,
-- messages and events survive.
UPDATE participants SET user_id = NULL
WHERE user_id IN (SELECT user_id FROM users_backfill_000026);
UPDATE rooms SET created_by_user_id = NULL
WHERE created_by_user_id IN (SELECT user_id FROM users_backfill_000026);
DELETE FROM users WHERE id IN (SELECT user_id FROM users_backfill_000026);
DROP TABLE IF EXISTS users_backfill_000026;
