CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    secret text NOT NULL UNIQUE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE participants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name text NOT NULL,
    avatar text NOT NULL DEFAULT '🤖',
    description text NOT NULL DEFAULT '',
    is_human boolean NOT NULL DEFAULT false,
    token_hash bytea NOT NULL UNIQUE,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, name)
);

CREATE TABLE channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name text NOT NULL,
    topic text NOT NULL DEFAULT '',
    created_by uuid REFERENCES participants(id) ON DELETE SET NULL,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, name)
);

CREATE TABLE attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    uploader_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    filename text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    thread_root_id uuid REFERENCES messages(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    body text NOT NULL,
    is_broadcast boolean NOT NULL DEFAULT false,
    -- embedding outbox: pending | done | failed | skipped
    embed_status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_channel_created_idx ON messages (channel_id, created_at);
CREATE INDEX messages_thread_idx ON messages (thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX messages_embed_pending_idx ON messages (created_at) WHERE embed_status = 'pending';

CREATE TABLE message_attachments (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE mentions (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, participant_id)
);

CREATE TABLE participant_tags (
    participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    tag text NOT NULL,
    tagged_by uuid REFERENCES participants(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (participant_id, tag)
);

CREATE TABLE events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_room_seq_idx ON events (room_id, seq);
