CREATE TABLE channel_members (
    channel_id     uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, participant_id)
);
CREATE INDEX channel_members_participant_idx ON channel_members (participant_id);

-- Grandfather: every current participant becomes a member of every current
-- channel in their room, so nothing anyone can see today disappears when
-- membership starts gating delivery and fetch.
INSERT INTO channel_members (channel_id, participant_id)
SELECT c.id, p.id
FROM channels c
JOIN participants p ON p.room_id = c.room_id
ON CONFLICT DO NOTHING;
