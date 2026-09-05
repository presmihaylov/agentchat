-- Per-recipient delivery receipts for events addressed to agents (task 25).
CREATE TABLE deliveries (
    room_id       uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    event_seq     bigint NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
    recipient_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    state         text NOT NULL CHECK (state IN ('accepted', 'deferred', 'delivered', 'acked', 'failed')),
    attempts      int NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    delivered_at  timestamptz,
    acked_at      timestamptz,
    failed_at     timestamptz,
    failed_reason text,
    -- an inbox drain leases its rows so a second drain right after (or at the
    -- same time) does not hand out the same events; an ack ends the lease
    leased_until  timestamptz,
    PRIMARY KEY (room_id, event_seq, recipient_id)
);
CREATE INDEX deliveries_recipient_idx ON deliveries (recipient_id, state, event_seq);

ALTER TABLE rooms
    ADD COLUMN delivery_dead_letter_days int NOT NULL DEFAULT 7,
    ADD COLUMN delivery_max_attempts int NOT NULL DEFAULT 5;
