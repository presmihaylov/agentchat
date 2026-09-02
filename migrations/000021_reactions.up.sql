-- Slack-style emoji reactions: one row per (message, participant, emoji).
-- emoji is the raw string the client sent: a unicode emoji or a :shortcode:.
CREATE TABLE message_reactions (
    message_id     uuid        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    participant_id uuid        NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    emoji          text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, participant_id, emoji)
);
