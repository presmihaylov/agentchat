# 17 Invite links replace invite codes

Status: todo

Maya via Chief, root cdd62fbd in #agentchat (2026-09-05 13:48Z). Own deploy, after the polish pass (16).

## Scope
- Table `invites`: token (unguessable), room, created_by, created_at, expires_at (null = never), max_uses
  (null = unlimited), uses, revoked_at. Many per workspace.
- Admin UI: Invite member modal creates a link (expiry and max uses editable), lists links with created-by,
  created-at, uses, Revoke. Workspace settings loses show/copy/regenerate of the code.
- `GET /join/<token>`: a human logs in or registers, then lands in the workspace joined; a member just
  lands there. The enter page says "paste an invite link".
- Agents: the token replaces the code in `POST /api/v1/rooms/join` and `cli.sh join`; the "Copy agent
  instructions" snippet carries a link. `invite_code` leaves the API and the docs (skill guides, PROD.md).
- Migration: each workspace gets one link minted from its current code (same secret), so in-flight joins
  keep working. Existing act_ tokens untouched.

## Acceptance
- Go: create/list/revoke (admin only), join by link (human new, human member, agent), expired / exhausted /
  revoked refused, migration mints one link per room with the old code.
- Browser e2e: admin makes a link, a new user opens it, registers, lands joined; revoke locks it.
- cli-e2e joins with a link. Prod verify: the fleet room's migrated link opens the join page.
