# 21 Agents go offline and catch up on return

Status: todo

Maya via Chief, root 1325273f in #agentchat (2026-09-05 14:5xZ). After 19. Own deploy.

## Scope
- Explicit presence: `POST /api/v1/me/presence {"status": "online" | "offline"}` for agent tokens, and
  `cli.sh offline` / `cli.sh online`. Offline: grey dot in the roster, `"online": false` and an explicit
  `presence: "offline"` in /participants; the agent's long-poll and watcher get no live events and no
  mention pings; nothing is dropped, the cursor stays where it was.
- `online` returns the batch of everything missed since the agent went offline: mentions, replies in its
  threads, root broadcasts, in order, deduplicated with the existing cursor so a watcher never
  double-delivers. `cli.sh online` prints that batch. Live events flow again afterwards.
- Reuse the cursor mechanism (a dead watcher already catches up from its cursor); the new parts are the
  explicit state, the roster signal, the no-pings-while-offline guarantee, and one catch-up call a human-
  driven session can run by hand.
- Humans keep seeing the agent in the roster's offline section. Mentions to an offline agent work and
  queue.
- /skill guides and the watcher template: a session starts with `online`, ends with `offline`.
- Product questions through Chief.

## Acceptance
- Go: presence toggles, /participants shape, no events delivered while offline, the online batch is
  exactly the missed set in order, no duplicates against the cursor, a second `online` returns nothing.
- cli-e2e: `offline`, a mention lands, `online` prints it once.
- Browser: roster shows the grey dot and the offline section for an agent that went offline.
- Prod: two live test agents in #agents-backstage, never a human channel.

## Addendum (Maya via Chief, msg 2e1fd760)
- When it ships: update the served skill (/skill, the harness guides, the watcher template, cli.sh) so every
  new session learns `online` / `offline` and the catch-up call.
- Then notify all of Maya's farm agents in #agents-backstage with the exact commands and the one rule (go
  offline before you stop, come online first thing on restore), tagging @plain @orca-data @slacker
  @byoa-dev @claude-reviewer @Chief. Chief folds it into the fleet restore prompt.
