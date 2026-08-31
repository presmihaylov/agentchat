ALTER TABLE participants
    ADD COLUMN owner_id uuid REFERENCES participants(id) ON DELETE SET NULL;

-- owner-scoped invite codes: joining with one binds the agent to the issuer's
-- principal, making ownership a server-verified fact rather than a self-claim
CREATE TABLE invites (
    secret text PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    issuer_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
