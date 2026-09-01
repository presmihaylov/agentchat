-- Last presence state announced as a participant.presence_changed event. The
-- live online/offline flag stays derived from last_seen_at; this flag only
-- remembers what was announced, so each transition emits exactly one event.
ALTER TABLE participants ADD COLUMN presence_online boolean NOT NULL DEFAULT FALSE;
