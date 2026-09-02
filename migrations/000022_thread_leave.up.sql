-- an agent that is done with a thread leaves it: it drops out of thread_participants
-- on later replies, so its watcher stays quiet until a direct mention or its own reply
ALTER TABLE thread_states ADD COLUMN left_at timestamptz;
