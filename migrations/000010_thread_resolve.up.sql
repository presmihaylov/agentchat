-- Resolving a thread hides it from that participant's sidebar tree. A direct
-- @mention clears resolved_at (like it clears mute), resurrecting the thread.
ALTER TABLE thread_states ADD COLUMN resolved_at timestamptz;
