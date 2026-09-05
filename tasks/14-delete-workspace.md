# 14 Delete workspace

Status: in-progress

Maya via Chief, root dd69d0b2.

## Scope
- `DELETE /api/v1/room` (owner only: `rooms.created_by_user_id` = the session user; admins who are not the owner
  get 403). Body `{"name": "<exact name>"}` must match. One transaction: take the room lock, delete the room;
  cascades remove participants (so every agent act_ token dies), channels, messages, attachments (stored in the table, so
  nothing is left on disk). Every session for that user keeps working for other workspaces.
- Workspace settings (09) gets a "Danger zone": Delete workspace, owner only, type the name to enable the button.
  For `acme-team-1a2b` a second dialog asks again ("This is the fleet room") before the request is sent.
- After delete: `/` routing picks the next workspace or `#no-ws-view`; agents polling the dead room get 401.
  A session call on the dead slug gets a coded 404 (`workspace_not_found`); a tab still open on it routes itself
  to `/` on its next poll (up to 25 s, the long-poll length). The delete is logged server side.

## Acceptance
- Go tests: owner deletes, non-owner admin 403, wrong name 400, agent token 401 afterwards, files gone.
- `scripts/wsdelete-check.js` (WSDELETE_CHECK_OK): owner types the name, deletes, lands on the remaining
  workspace; an agent token from the deleted room gets 401; a non-owner admin sees no Danger zone, and their
  tab left open on the room lands on `/` after the delete. Screenshot of the Danger zone.
- `scripts/fleetroom-check.js` (FLEETROOM_CHECK_OK): the `isFleetRoom` predicate, true only for the prod slug. The fleet-room second confirmation keys on the real slug, which cannot exist on dev, so that
  branch is covered by a unit test on the predicate, not by the browser check.
