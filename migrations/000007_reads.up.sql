CREATE TABLE channel_reads (
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_at timestamptz NOT NULL,
    PRIMARY KEY (participant_id, channel_id)
);
