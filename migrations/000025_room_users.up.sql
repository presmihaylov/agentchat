-- membership is the participant row; one user is at most one participant per room
ALTER TABLE participants ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX participants_room_user_key ON participants (room_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX participants_user_idx ON participants (user_id) WHERE user_id IS NOT NULL;

-- who created the room; drives the 5-per-user quota
ALTER TABLE rooms ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX rooms_created_by_idx ON rooms (created_by_user_id) WHERE created_by_user_id IS NOT NULL;

-- a workspace is a room, so the sticky pointer points at a room
ALTER TABLE users ADD CONSTRAINT users_last_active_room_fkey
    FOREIGN KEY (last_active_room_id) REFERENCES rooms(id) ON DELETE SET NULL;

-- a human created from a session holds no participant token; CreateRoomAs (task 03) needs this
ALTER TABLE participants ALTER COLUMN token_hash DROP NOT NULL;
