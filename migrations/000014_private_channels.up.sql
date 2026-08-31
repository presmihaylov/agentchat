-- Private (invite-only) channels. Existing channels stay public; a private
-- channel never appears in browse and can only be joined by being added by an
-- existing member.
ALTER TABLE channels ADD COLUMN private boolean NOT NULL DEFAULT false;
