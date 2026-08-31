ALTER TABLE participants
    ADD COLUMN avatar_attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL;
