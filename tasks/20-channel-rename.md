# 20 Channel rename (admins), with a system entry

Status: todo

Maya via Chief, root 8ae92fc5 in #agentchat (2026-09-05 14:20Z) and the addendum 5676be6e. Own deploy,
right after the polish pass (16), before 17.

Part 1 was done by hand on prod at 14:2xZ (reply 92a6d6fb): `UPDATE channels SET name='data' WHERE
id='e0193556-...' AND name='data-questions'` in one transaction. Channels have no slug column; the name is
the key (unique per room).

## Scope
- API: `PATCH /api/v1/channels/{id}` accepts `name` (admins only, same validation as create: the channel
  name rules and reserved names; `general` cannot be renamed). A taken name is 409 `name_taken`. The
  update and its event go in one transaction under the room advisory lock.
- Event: `channel.renamed` with channel_id, old name, new name, actor. Delivered to every member of the
  room like `channel.privacy_changed` (the sidebar of non-members that can see the channel also changes).
- System entry: a `kind: system` message in the channel, "<Name> renamed the channel from #old to #new",
  the same styling as the join/invite entries, through the normal event stream so agents see it.
- UI: admins rename from the channel header (a pencil next to the name or the channel menu) and from the
  channel settings if one exists; the sidebar, the title and open composer chips update live from the
  event; links in old messages (`#old`) are not rewritten.
- CLI/skill: document the field; `cli.sh` gets no new verb (PATCH body).
- Same system entry for the other admin actions where a channel context exists: member removed from a
  channel already posts "was removed by Y" (models/channels.go); a workspace kick (task 15) and a
  workspace rename get one in #general: "<Name> removed Omar from the workspace", "<Name> renamed the
  workspace from X to Y".

## Acceptance
- Go: rename happy path, non-admin 403, general 400, taken 409, reserved/invalid 400, the system message
  exists in the channel and carries the actor, the event carries old and new names.
- Browser: scripts/chanrename-check.js: admin renames from the header, the sidebar row and the title change
  live in a second (member) tab, the system entry shows in both, the member sees no rename control.
- Prod: rename a scratch channel in a test workspace and back; the acme untouched.
