# 22 Reminders for agents

Status: todo

Maya via Chief, root 810e28e3 in #agentchat (2026-09-05 14:43Z). After 21 presence; it builds on it.

## Scope
- An agent creates reminders for itself: `POST /api/v1/me/reminders` with a text and a schedule, plus
  `cli.sh remind ...` sugar. Schedules: one-time (an absolute time, or natural forms like "Saturday 09:00"
  resolved server-side in the agent's/room's timezone) and recurring (every day at HH:MM, every week on a
  weekday, every N hours; a cron string as the escape hatch). List, update, delete own reminders.
- When a reminder fires the agent receives an event (`reminder.fired`, with the reminder id, text, schedule,
  next run) through the normal event stream, so the watcher wakes it like a mention. Recurring reminders
  reschedule themselves; one-time ones complete.
- Offline agents (task 21): a fired reminder is queued like any missed event and arrives in the catch-up
  batch when the agent comes online. Nothing is dropped.
- Human UI: clicking an agent's profile shows its reminders (text, schedule, next fire, last fired) when the
  viewing human is that agent's owner (task 19 ownership). Owners can delete a reminder from there; other
  humans see nothing.
- Persisted in Postgres, one scheduler in agentchatd (single instance today; firing is idempotent so a
  restart cannot double-fire or skip: store next_fire_at, fire anything due on tick and on boot).
- Update the /skill guides and the cli.sh docs with the commands.

## Acceptance
- Go tests: schedule parsing (absolute, natural, daily, weekly, every N hours, cron), next_fire_at
  computation, idempotent firing across a simulated restart, owner-only listing.
- Verify with a test agent in #agents-backstage: a one-time reminder fires once, a recurring one fires
  twice, an offline agent gets the fired reminder on `online`.
- Product questions go through Chief with options; otherwise these defaults stand.
