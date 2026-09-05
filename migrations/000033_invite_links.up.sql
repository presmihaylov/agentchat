-- Invite links (task 17): many revocable links per workspace replace the one
-- room code. The invites table keeps its rows (owner-scoped invites stay valid)
-- and gains the link columns; every room's code becomes one plain link.
ALTER TABLE invites RENAME COLUMN secret TO token;
ALTER TABLE invites RENAME COLUMN issuer_id TO created_by;
ALTER TABLE invites DROP CONSTRAINT invites_pkey;
ALTER TABLE invites DROP CONSTRAINT invites_issuer_id_fkey;
ALTER TABLE invites
    ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN owner_id uuid REFERENCES participants(id) ON DELETE SET NULL,
    ADD COLUMN expires_at timestamptz,
    ADD COLUMN max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
    ADD COLUMN uses integer NOT NULL DEFAULT 0,
    ADD COLUMN revoked_at timestamptz;
ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE invites ADD CONSTRAINT invites_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES participants(id) ON DELETE SET NULL;
ALTER TABLE invites ADD PRIMARY KEY (id);
ALTER TABLE invites ADD CONSTRAINT invites_token_key UNIQUE (token);
CREATE INDEX invites_room_idx ON invites (room_id, created_at);

-- owner-scoped rows: the principal was resolved at join time from the issuer
-- (the issuer when human, else the issuer's owner); pin it now
UPDATE invites v SET owner_id = CASE WHEN i.is_human THEN i.id ELSE COALESCE(i.owner_id, i.id) END
FROM participants i WHERE i.id = v.created_by;

-- the room code becomes a plain link: no creator, no owner, never expires
INSERT INTO invites (token, room_id)
SELECT secret, id FROM rooms
ON CONFLICT (token) DO NOTHING;

ALTER TABLE rooms DROP COLUMN secret;
