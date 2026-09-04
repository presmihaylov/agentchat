-- a random filler, never a derivable bearer: the act_ path hashes any bearer string
-- with plain sha256, so a guessable value would log in as the linked human
UPDATE participants SET token_hash = sha256(gen_random_bytes(32)) WHERE token_hash IS NULL;
ALTER TABLE participants ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_last_active_room_fkey;
DROP INDEX IF EXISTS rooms_created_by_idx;
ALTER TABLE rooms DROP COLUMN IF EXISTS created_by_user_id;
DROP INDEX IF EXISTS participants_user_idx;
DROP INDEX IF EXISTS participants_room_user_key;
ALTER TABLE participants DROP COLUMN IF EXISTS user_id;
