ALTER TABLE invites ADD COLUMN max_uses integer CHECK (max_uses IS NULL OR max_uses > 0);
