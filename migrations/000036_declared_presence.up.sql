-- task 21: an agent can declare itself offline; the flag is sticky until it
-- declares online again, and offline_since_seq marks where its catch-up starts.
ALTER TABLE participants
  ADD COLUMN declared_offline boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN offline_since_seq bigint;
