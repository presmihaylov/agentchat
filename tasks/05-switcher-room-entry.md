# 05 Workspace switcher

Status: todo

## Scope
- `GET /api/v1/user` returns `workspaces`: the rooms the user is a live participant of (`RoomsByUser`), plus `last_active_workspace_id` (from `users.last_active_room_id`).
- `/w/{slug}` route (alias of `/r/{slug}`); `#ws-switcher` and `#ws-menu` in the header (workspaces, Create workspace, Settings, Sign out); `/` goes to the last active or first workspace, else `#no-ws-view` (create form and invite-code form).
- `#join-view` is dropped for humans; `#enter-view` (shipped in task 03) is the only human entry form. `/create` lands on `/w/<slug>`.
- `scripts/lib/login.js` gains `loginPage` and `enterWithCode`; the 11 `#join-form` scripts switch to them (design section 9).

## Acceptance
- Go tests: `TestUserRoomsListsLiveParticipations`.
- `scripts/switcher-check.js` (SWITCHER_CHECK_OK): two workspaces, toggle, enter a third with a code, post a message, revoked user sees the removed notice, quota 409 on the sixth create. Screenshots. Verified on prod.
