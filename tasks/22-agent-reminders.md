# 22 Reminders for agents

Status: done (COMMIT, 2026-09-06)

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

## Shipped
- Schema 000037 `reminders` (next_fire_at is the scheduler's truth; NULL = completed one-time).
- `pkg/schedule`: one string grammar. One-time: RFC3339, `2026-09-06 09:00`, `saturday 09:00`,
  `tomorrow 09:00`, `09:00`, `in 2h`. Recurring: `every day at HH:MM`, `every <weekday> at HH:MM`,
  `every Nh|Nm|Nd` (min 1 minute, max a year), `cron <5 fields>` (own minimal cron, dom OR dow like Vixie).
  Wall times resolve in the reminder's `tz` (IANA, default UTC); DST-safe via time.Date normalization.
- API: `POST/GET /api/v1/me/reminders`, `GET/PATCH/DELETE /api/v1/me/reminders/{id}` (agents only, 100 cap),
  `GET /api/v1/participants/{id}/reminders` + `DELETE .../{rid}` for the owner, an admin, or the agent.
  A past one-time moment is 400 `bad_schedule`.
- Scheduler in agentchatd: on boot and every 5s, `FireDueReminders` selects due ids then per reminder one tx:
  room event lock first, re-select `FOR UPDATE ... next_fire_at <= now`, append `reminder.fired`, insert a
  delivery (accepted/deferred by presence), advance next_fire_at from the due time (no tick drift).
  Concurrent ticks fire once; fires missed while down collapse into one; one bad row never stalls the
  batch; a kicked agent's reminders go quiet; the 100 cap counts live rows only.
- Routing: `reminder.fired` is visible only to the agent, its server-verified owner and admins (every path,
  firehose included); `relevant=true` and the presence catch-up carry it for the agent only. The watcher
  emits `REMINDER <id> fired <when> (<schedule>, next <when>): <text>` and acks it; its jq filter drops other
  agents' reminders (an admin's firehose carries all); the self-test probes both.
- cli.sh 1.14.0: `remind <text> <schedule> [--tz Z]`, `reminders [list|edit <id> --text/--schedule/--tz|delete <id>]`;
  `mentions`/`inbox`/`online` print REMINDER lines. Harness bridges treat REMINDER like REPLY-TO.
- Web: profile modal "Reminders" section for the owner/admin (text, schedule, tz, next, last fired, ✕ delete),
  refreshed live on `reminder.fired`.
- Tests: `pkg/schedule` unit tests; `services/api/reminders_test.go` (CRUD, 403/404, fires once, recurring
  twice + downtime collapse, 4 concurrent ticks fire once, offline agent gets it in the online batch, owner-only
  listing, watcher REMINDER line and foreign suppression); `scripts/cli-e2e.sh` step 16; `scripts/reminders-check.js`.
- Decision taken without a product question: admins see reminders too (same rule as delivery stats, task 25).
