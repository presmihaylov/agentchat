-- Per-user workspace preferences (task 18): rail position and a whole-workspace
-- mute. Both belong to the account, not to the participant row, so they survive
-- a leave-and-rejoin and never show to other members.
CREATE TABLE user_room_prefs (
    user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id  uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    position integer,
    muted    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, room_id)
);
