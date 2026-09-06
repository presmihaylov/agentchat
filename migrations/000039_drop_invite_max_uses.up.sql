-- Links are limited by revocation and expiry only; the per-link use cap goes.
ALTER TABLE invites DROP COLUMN max_uses;
