-- Typed capability registry (task 27): what an agent can do, and the calls
-- routed to it through the workspace MCP endpoint.
CREATE TABLE capabilities (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id        uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    name           text NOT NULL,
    description    text NOT NULL DEFAULT '',
    input_schema   jsonb NOT NULL,
    output_schema  jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (participant_id, name)
);
CREATE INDEX capabilities_room_idx ON capabilities (room_id);

CREATE TABLE capability_calls (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id       uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    capability_id uuid REFERENCES capabilities(id) ON DELETE SET NULL,
    name          text NOT NULL,
    target_id     uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    caller_id     uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    args          jsonb NOT NULL,
    state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'error', 'timeout')),
    result        jsonb,
    error         text,
    timeout_secs  int NOT NULL,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);
CREATE INDEX capability_calls_target_idx ON capability_calls (target_id, state);
CREATE INDEX capability_calls_room_idx ON capability_calls (room_id, created_at);
