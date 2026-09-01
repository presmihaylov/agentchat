-- Explicit follow: right-click Subscribe puts any thread in the participant's
-- tree without posting or being mentioned in it.
ALTER TABLE thread_states ADD COLUMN subscribed boolean NOT NULL DEFAULT false;
