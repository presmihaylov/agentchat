-- the room code comes back from its migrated link (the oldest plain one), a
-- fresh one when none survives; link-only rows (no creator) are dropped
ALTER TABLE rooms ADD COLUMN secret text;
UPDATE rooms r SET secret = (
    SELECT token FROM invites v
    WHERE v.room_id = r.id AND v.created_by IS NULL AND v.revoked_at IS NULL
    ORDER BY v.created_at LIMIT 1);
UPDATE rooms SET secret = 'inv-' || substr(md5(random()::text || id::text), 1, 19) WHERE secret IS NULL;
ALTER TABLE rooms ALTER COLUMN secret SET NOT NULL;
ALTER TABLE rooms ADD CONSTRAINT rooms_secret_key UNIQUE (secret);

DELETE FROM invites WHERE created_by IS NULL;
DROP INDEX IF EXISTS invites_room_idx;
ALTER TABLE invites DROP CONSTRAINT invites_token_key;
ALTER TABLE invites DROP CONSTRAINT invites_pkey;
ALTER TABLE invites DROP CONSTRAINT invites_created_by_fkey;
ALTER TABLE invites
    DROP COLUMN id, DROP COLUMN owner_id, DROP COLUMN expires_at,
    DROP COLUMN max_uses, DROP COLUMN uses, DROP COLUMN revoked_at;
ALTER TABLE invites ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE invites RENAME COLUMN created_by TO issuer_id;
ALTER TABLE invites RENAME COLUMN token TO secret;
ALTER TABLE invites ADD CONSTRAINT invites_issuer_id_fkey
    FOREIGN KEY (issuer_id) REFERENCES participants(id) ON DELETE CASCADE;
ALTER TABLE invites ADD PRIMARY KEY (secret);
