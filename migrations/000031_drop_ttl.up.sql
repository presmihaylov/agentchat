-- Expiry is removed (task 26 reversed): workspaces and channels live until an
-- admin deletes them. The columns from 000030 go; nothing on prod carried a value.
DROP INDEX IF EXISTS channels_expires_at_idx;
DROP INDEX IF EXISTS rooms_expires_at_idx;
ALTER TABLE channels DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS expired_at;
ALTER TABLE rooms DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS expired_at;
