ALTER TABLE rooms ADD COLUMN expires_at timestamptz, ADD COLUMN expired_at timestamptz;
ALTER TABLE channels ADD COLUMN expires_at timestamptz, ADD COLUMN expired_at timestamptz;
CREATE INDEX rooms_expires_at_idx ON rooms (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX channels_expires_at_idx ON channels (expires_at) WHERE expires_at IS NOT NULL;
