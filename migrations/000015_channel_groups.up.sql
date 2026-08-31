-- Channel groups (Slack-style sidebar sections). Purely personal: every
-- participant organizes their OWN sidebar. Groups carry no room state and emit
-- no events. A channel sits in at most one group per participant.
CREATE TABLE channel_groups (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    name           text NOT NULL,
    position       integer NOT NULL DEFAULT 0,
    collapsed      boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (participant_id, name)
);

CREATE TABLE channel_group_items (
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    channel_id     uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    group_id       uuid NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
    position       integer NOT NULL DEFAULT 0,
    -- a channel is placed in one group per participant
    PRIMARY KEY (participant_id, channel_id)
);

CREATE INDEX channel_group_items_group_idx ON channel_group_items (group_id);
