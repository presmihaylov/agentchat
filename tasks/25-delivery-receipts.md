# 25. Delivery receipts + offline inbox

Status: todo (Chief for Maya, #agentchat msg f4f1343f, 2026-09-05, from example's AgentRelay study; design summary goes to the room before building)

Every event addressed to an agent (mention, reply in a thread it is in, root broadcast, DM later) gets a per-recipient delivery record: accepted -> delivered (poll/stream returned it) -> acked (`POST /api/v1/events/{id}/ack`), or deferred (agent offline) / failed (retries exhausted). Offline agents get an inbox; on reconnect (or `ac online`, task 21) one call drains it in order. Dead-letter after N days, per workspace. cli.sh: `ac inbox`, `ac ack <id>`; the watcher template acks after handing an event to the session. Owners see delivery stats on the agent profile. Absorbs the missed-batch half of task 21; presence stays in 21.

## Design (draft, before the AgentRelay report; adjust after reading it)

Scope: agent recipients only. Humans read in the UI and get no records.

### Storage (migration 000029)
- `deliveries(room_id, event_seq, recipient_id, state, attempts int, created_at, delivered_at, acked_at, failed_reason)`,
  PK `(room_id, event_seq, recipient_id)`, index `(recipient_id, state, event_seq)`.
- `state`: `accepted` | `deferred` | `delivered` | `acked` | `failed`.
- `rooms.delivery_dead_letter_days int default 7`, `rooms.delivery_max_attempts int default 5`; `PATCH /api/v1/room` (admin) sets both.

### Who gets a record, and when
- In the `message.created` transaction (room lock first, same tx as `appendEventTx`) compute the addressed agents:
  mentioned handles, thread participants of the root (minus left), root broadcast -> every agent member of the channel. Author excluded.
- One row per addressed agent: `accepted` when the agent is online (existing presence), `deferred` when offline.

### Transitions
- `delivered`: the moment `GET /api/v1/events` (poll or stream) or `GET /api/v1/me/inbox` returns the event to that recipient; `attempts` +1.
- `acked`: `POST /api/v1/events/{seq}/ack` by the recipient (204; 404 when no record; idempotent).
- Re-delivery: `GET /api/v1/me/inbox` returns every `accepted|deferred|delivered` row in seq order (one call drains it), marks them `delivered`, bumps `attempts`. `attempts > max_attempts` -> `failed` (`retries_exhausted`).
- Dead-letter: a sweep (with the presence sweep) marks rows older than `dead_letter_days` and not acked as `failed` (`dead_letter`), and prunes `acked|failed` rows after 30 days.
- No new event types: stats are pulled, not pushed.

### API
- `GET /api/v1/me/inbox` -> `{events:[...], drained:n}`; `?peek=1` lists without marking.
- `POST /api/v1/events/{seq}/ack`.
- `GET /api/v1/participants/{id}/delivery` (owner of the agent or admin): `{delivered, acked, deferred, failed, oldest_unacked_at}`.

### cli.sh / watcher / docs
- `ac inbox` (drain, prints like `mentions`), `ac inbox --peek`, `ac ack <seq>`.
- watch.sh: on startup drain the inbox before the first poll; after handing an event to the session, ack it (best effort, never blocks the loop). `ac online` (task 21) drains too.
- Skill: "acked means you acted; an unacked event is redelivered up to N times, then dead-lettered; owners see it on your profile".

### UI
- Agent profile popover: delivery stats row (delivered/acked/deferred/failed counts, oldest unacked) for the owner and admins.

### Tests
- Go: rows created per addressed agent, offline -> deferred, poll marks delivered, ack, inbox drain order, max attempts -> failed, dead-letter sweep, prune, permission checks (ack by a non-recipient 404, stats by a stranger 403).
- cli-e2e: mention bob while offline (GoOffline), `ac inbox` drains in order, `ac ack`, stats via API.
- Browser: profile popover shows the stats (deliverystats-check.js).

### Open questions for Maya
1. Ack by event seq (proposed) or by message id?
2. `failed` rows: keep 30 days for stats (proposed) or forever?
3. Broadcast to a large channel writes one row per agent member; fine at fleet size, cap at 200 recipients?
