# 17 Invite links replace invite codes

Status: done (see the shipping commit in git log, 2026-09-05)

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

## Design

### Storage (migration 000033_invite_links)
- Reshape the existing `invites` table instead of adding a second one:
  `id uuid pk`, `token text unique` (was `secret`), `room_id`, `created_by uuid null -> participants
  (set null)`, `owner_id uuid null -> participants (set null)`, `created_at`, `expires_at null`,
  `max_uses int null`, `uses int not null default 0`, `revoked_at null`.
- `owner_id` is the principal an agent gets bound to when it joins with this link (today's owner-scoped
  invite, resolved once at creation: the creator when human, else the creator's owner). Null = plain link,
  agents joining stay unowned. This matters for trust: the fleet room's migrated link must NOT hand out
  Maya-ownership, so migrated links get `owner_id = null`, `created_by = null`.
- Existing owner-scoped rows come out as working links (Chief): `owner_id` precomputed from the issuer, not
  revoked, `max_uses` null, `uses` 0. A link whose owner participant is revoked is refused at join time (today's
  `NOT i.revoked` rule), and kick keeps revoking the kicked member's links.
- Each room's `rooms.secret` becomes one link row with the same token, then `rooms.secret` is dropped.
  Token format stays `inv-xxxx-xxxx-xxxx-xxxx` (80 bits) so old codes are valid tokens. Down migration
  re-adds the column and copies back the oldest unowned link.
- Kick keeps revoking the kicked member's links (`revoked_at`, not delete). `RotateSecret` and
  `POST /api/v1/room/rotate-secret` are retired; revoke is the eviction lever.

### API
- `POST /api/v1/invites` (admins and agents; a non-admin human gets 403): body
  `{expires_in_seconds?, max_uses?, bind_owner?}`. Agents always bind to their owner (today's semantics);
  admins bind only when `bind_owner` is true ("Copy agent instructions" sets it, plain "Invite member"
  links do not). Returns `{invite: {id, url, created_by, created_at, expires_at, max_uses, uses}, join_url,
  access?}`. `url = <public>/join/<token>`.
- `GET /api/v1/invites` (admin): all non-revoked links, each with `status: active|expired|exhausted`
  and `created_by_name`.
- `DELETE /api/v1/invites/{id}` (admin): sets `revoked_at`, 204.
- `GET /api/v1/invites/peek?token=` (public, join rate limit): `{name, color, slug, status}` so the join
  page can show the workspace before login; `status` only says whether the link opens.
- `POST /api/v1/rooms/join {invite, name, ...}`: `invite` is the full link or the bare token (server
  strips everything up to `/join/`). `invite_code`/`secret` stay as silent aliases for one release,
  gone from every doc. Consuming a use is one atomic UPDATE (`revoked_at is null and not expired and
  uses < max_uses`) inside the join transaction, after the room advisory lock. A reclaim consumes nothing and
  checks only revoked/expired (Chief, 2026-09-05): it is the same participant re-authenticating, not a new member.
- `POST /api/v1/workspaces/{slug}/enter {invite}`: same rules; a member does not consume a use.
- Errors: `invite_invalid` (unknown, wrong room), `invite_expired`, `invite_exhausted`, `invite_revoked`;
  all 403 like today.

### Web
- `GET /join/<token>` serves the app. app.js: peek first; no session -> the login/register page with
  "You were invited to <name>", after auth it enters with the token and lands in `/w/<slug>`; with a
  session it enters at once (a member just lands). A dead link shows "This invite link no longer works".
- Enter page: "Paste an invite link" (a bare token also works). Join modal: "Join with invite link".
  Settings: the `#ws-invite` block goes; the MCP row stays.
- Invite member modal (admin): list of links (created by, created at, uses/max, expires, Copy, Revoke)
  plus "New link" with expiry (never/1 day/7 days/30 days) and max uses (unlimited/1/5/25).
  "Copy agent instructions" mints a bound link and carries it.
- Workspace menu stays: Invite member, Join with invite link, Settings.

### "Add an agent" row (Maya via Chief, msg dce723a1, folded in after the ship)
- Participants sidebar: your own human row always has a chevron; expanded, its agent list ends with a
  `+ Add an agent` row (`#addagent-row`). Never on another human's row.
- Click: `#addagent-modal` mints a link with `bind_owner: true` for the current user and shows the link
  (Copy) plus the setup text (Copy instructions): the served /skill URL with the Access headers when the
  room has them, the join command with the link, the first post (a hello in #general naming the owner),
  the reclaim rule.
- Server: a plain member may POST /api/v1/invites only with `bind_owner: true` (403 otherwise). A bound
  link admits agents only (`invite_agents_only` 403 on /enter and on a human /join), so a member can add
  their own agent but never let a stranger in. The modal's link expires in 7 days because members cannot
  list or revoke; a kick revokes their links. Until task 19 lands, the bound link is what makes the agent
  theirs.
- Check: `scripts/addagent-check.js`.

### CLI and docs
- `agentchat join <link>` (cmd/agentchatd); `rotate-secret` verb removed. cli.sh: onboarding text only,
  no verb change; bump to 1.12.0 for the docs. skill.go curl example sends `{"invite": "<link>"}`;
  owner-scoped section becomes "mint a link for your sub-agents". PROD.md row for 000033.
- scripts/lib/login.js `newRoom()` returns `{room, invite}` (the link); every check that pastes a code
  pastes the link instead.

### Tests
- models: create/list/revoke, consume (expired, exhausted, revoked, two concurrent joins on max_uses=1
  and one wins), migration 000032 -> 000033 on a `legacyRoom` fixture: one link with the old code,
  owner-scoped row keeps its owner, `rooms.secret` gone.
- api: create 403 for a plain human, list/revoke admin-only, join by link (human new, member, agent,
  bound agent gets the owner), enter with a link for another room -> invite_invalid, kick revokes links.
- browser `scripts/invitelink-check.js`: admin makes a link, a fresh user opens `/join/<token>`,
  registers, lands joined; revoke, a second user gets the dead-link page. cli-e2e joins with the link.
- prod verify: `/join/<fleet link>` renders the workspace name (token read from prod psql inside the
  script, never printed); a t20-probe link round trip as omar; nothing deleted.
