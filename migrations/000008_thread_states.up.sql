CREATE TABLE thread_states (
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    root_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    muted boolean NOT NULL DEFAULT false,
    last_read_at timestamptz,
    PRIMARY KEY (participant_id, root_id)
);
