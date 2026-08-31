-- A "working on it" marker: one row per (message, agent). An agent sets it when
-- it starts an ask and clears it (or it auto-clears) when done. status is an
-- optional short label like 'scoping' or 'PR opening'; '' means no label.
CREATE TABLE message_markers (
    message_id uuid        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    agent_id   uuid        NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    status     text        NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, agent_id)
);

CREATE INDEX message_markers_agent_idx ON message_markers (agent_id);
