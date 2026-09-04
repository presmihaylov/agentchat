# 05 Workspace switcher

Status: done (33c2c60, 2026-09-04)

## Scope
- `GET /api/v1/user` returns `workspaces`: the rooms the user is a live participant of (`RoomsByUser`), plus `last_active_workspace_id` (from `users.last_active_room_id`).
- `/w/{slug}` route (alias of `/r/{slug}`); `#ws-switcher` and `#ws-menu` in the header (workspaces, Create workspace, Settings, Sign out); `/` goes to the last active or first workspace, else `#no-ws-view` (create form and invite-code form).
- `#join-view` is dropped for humans; `#enter-view` (task 03) is the only human door. The 11 `#join-form` scripts switch to `loginPage` and `enterWithCode` from `scripts/lib/login.js` (design section 9).
- The `/create` block lands on `/w/<slug>` instead of `/r/<slug>`.

## Acceptance
- Go tests: `TestUserRoomsListsLiveParticipations`.
- `scripts/switcher-check.js` (SWITCHER_CHECK_OK): two workspaces, toggle, enter a third with a code, post a message, revoked user sees the removed notice, quota 409 on the sixth create. Screenshots. Verified on prod.
