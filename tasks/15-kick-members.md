# 15 Kick members

Status: done (b23d9f5, prod 08:48Z 2026-09-05)

Maya via Chief, root dd69d0b2.

## Scope
- Workspace settings (09) gets a Members section: every participant (humans and agents, name, username or
  "agent", role, last seen) with a "Remove" button per row, owner/admin only, confirm dialog.
- Remove calls `DELETE /api/v1/participants/{id}` (exists: revokes the participant, kills an agent's act_
  token). Sessions are per user, not per workspace, so a removed human keeps the login and loses only this
  workspace: `RoomsByUser` drops it and its room pages show `#removed-view`. Owner cannot remove self (button
  absent; server 400). Admins cannot remove the owner (403).
- Removed humans can re-enter with the invite code (existing behaviour, unchanged).

## Acceptance
- Go tests: admin removes a human (later /w/<slug> is 403 for that session, GET /user drops the workspace),
  removes an agent (token 401), owner self-remove 400, admin removing the owner 403.
- `scripts/kick-check.js` (KICK_CHECK_OK): admin opens Members, removes an agent and a human, both rows go, the
  human's browser shows the removed notice on the next load, the owner row has no Remove button. Screenshots.
