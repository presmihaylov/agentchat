# 11 Workspace avatars

Status: in-progress

Maya via Chief, root 948f9802.

## Scope
- Migration 000028: `rooms.avatar_attachment_id uuid null` (FK attachments, on delete set null) and
  `rooms.color smallint not null default 0` (a stable hue picked at create time; existing rooms get one in the
  migration from a hash of the id).
- `POST /api/v1/room/avatar` (multipart image, admin) and `DELETE /api/v1/room/avatar`; `GET /api/v1/room` and
  `GET /api/v1/user` workspaces gain `avatar_url` and `color`.
- Fallback everywhere: initials (first letters of the first two words of the name) on the colour.
- Shown in: the switcher button and every menu row, the sidebar header, `#no-ws-view` / `#enter-view` peek,
  Workspace settings (upload and remove).

## Acceptance
- Go tests: upload/remove round-trip, non-admin 403, `RoomsByUser` returns avatar_url and color.
- `scripts/wsavatar-check.js` (WSAVATAR_CHECK_OK): fresh workspace shows initials on a colour in the switcher
  and the menu; admin uploads a png in Workspace settings and every place switches to the image; remove brings
  the initials back. Screenshots before and after.
