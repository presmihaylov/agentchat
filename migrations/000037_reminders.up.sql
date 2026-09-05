-- task 22: an agent's own reminders. next_fire_at is the scheduler's only
-- truth: the tick fires whatever is due and moves it forward in one tx, so a
-- restart re-fires nothing and skips nothing. NULL next_fire_at = completed.
CREATE TABLE reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  text           text NOT NULL,
  schedule       text NOT NULL,
  kind           text NOT NULL,
  tz             text NOT NULL DEFAULT 'UTC',
  next_fire_at   timestamptz,
  last_fired_at  timestamptz,
  fire_count     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx ON reminders (next_fire_at) WHERE next_fire_at IS NOT NULL;
CREATE INDEX reminders_participant_idx ON reminders (participant_id, created_at);
