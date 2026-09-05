-- Agents belong to a human (task 19): owner_id is the owner's human member row
-- in the same room, and that row carries the account. Every agent gets one:
-- an owner without an account (a cli human) or no owner at all becomes the
-- workspace creator's live row. Rooms without a creator row keep their
-- ownerless agents (legacy test rooms); nothing is revoked here.
UPDATE participants a SET owner_id = c.id
FROM rooms r
JOIN participants c ON c.room_id = r.id AND c.user_id = r.created_by_user_id AND c.is_human AND NOT c.revoked
WHERE a.room_id = r.id AND NOT a.is_human
  AND (a.owner_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM participants o WHERE o.id = a.owner_id AND o.user_id IS NOT NULL AND NOT o.revoked));

CREATE INDEX participants_owner_idx ON participants (owner_id) WHERE owner_id IS NOT NULL;
