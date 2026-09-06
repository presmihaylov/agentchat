-- The ungrouped channels become a real section ("Channels"): they need a stored
-- order like any other section, and a collapsed flag of their own.
-- A NULL group_id is that section: same table, same per-participant ordering.
ALTER TABLE channel_group_items ALTER COLUMN group_id DROP NOT NULL;
ALTER TABLE participants ADD COLUMN default_section_collapsed boolean NOT NULL DEFAULT false;
