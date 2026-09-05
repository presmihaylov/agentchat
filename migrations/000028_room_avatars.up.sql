ALTER TABLE rooms
    ADD COLUMN avatar_attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL,
    ADD COLUMN color smallint NOT NULL DEFAULT 0;
-- a stable hue per existing room; new rooms pick one at create time
UPDATE rooms SET color = (hashtext(id::text) & 2147483647) % 12;
