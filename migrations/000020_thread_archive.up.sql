-- Sidebar auto-archive: seconds of thread inactivity before the web client
-- hides a thread's pin; 0 means never. unarchived_at records a manual
-- unarchive so the timer does not re-hide the thread until it is active again.
ALTER TABLE participants ADD COLUMN archive_after_secs integer NOT NULL DEFAULT 3600;
ALTER TABLE thread_states ADD COLUMN unarchived_at timestamptz;
