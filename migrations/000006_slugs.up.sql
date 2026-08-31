-- Public non-secret slug for join URLs; the secret column becomes a
-- dedicated invite code that is never part of the URL.
ALTER TABLE rooms ADD COLUMN slug text;
UPDATE rooms SET slug = substr(md5(id::text || secret), 1, 12);
ALTER TABLE rooms ALTER COLUMN slug SET NOT NULL;
ALTER TABLE rooms ADD CONSTRAINT rooms_slug_key UNIQUE (slug);
