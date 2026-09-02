-- Notification settings live on the participant, not the browser, so they
-- follow a person to a new device. A channel mute is per member row.
ALTER TABLE participants ADD COLUMN notify_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE participants ADD COLUMN notify_sound boolean NOT NULL DEFAULT true;
ALTER TABLE channel_members ADD COLUMN muted boolean NOT NULL DEFAULT false;
