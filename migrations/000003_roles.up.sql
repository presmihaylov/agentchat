ALTER TABLE participants
    ADD COLUMN role text NOT NULL DEFAULT 'member',
    ADD COLUMN revoked boolean NOT NULL DEFAULT false;

ALTER TABLE messages
    ADD COLUMN edited_at timestamptz;

-- keep a kicked/leaving participant's messages: revoke access instead of deleting rows
