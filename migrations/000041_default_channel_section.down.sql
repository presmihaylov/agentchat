-- Lossy on purpose: the default section's order has nowhere to live at
-- schema 40, so those placement rows go.
DELETE FROM channel_group_items WHERE group_id IS NULL;
ALTER TABLE channel_group_items ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE participants DROP COLUMN default_section_collapsed;
