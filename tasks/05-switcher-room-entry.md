# 05 Workspace switcher, room list, room entry

Status: todo

## Scope
- `/w/{slug}` route, switcher in the header, room list per workspace (GET /api/v1/workspace/rooms, POST creates one).
- PUT /api/v1/user/active-workspace.
- `X-Room-Slug` on session requests to room routes; `ParticipantBySession` with revoked check (`403 room_forbidden`, reason).
- Lazy projection `EnsureHumanParticipant` for members; POST /api/v1/rooms/{slug}/enter with optional invite code for non-members (adds membership, never adopts by name).
- `/create` means create workspace; `#join-view` becomes the non-member invite-code bridge.

## Acceptance
- Go tests: session resolves participant, no membership 403, revoked 403 from both paths, enter with code joins workspace, enter never adopts by name, `participant.joined` emitted once.
- `scripts/switcher-check.js` (SWITCHER_CHECK_OK): two workspaces, toggle, room list, enter room, post a message, revoked user blocked. Screenshots. Verified on prod.
