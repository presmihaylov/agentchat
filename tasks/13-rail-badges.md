# 13 Per-workspace badges in the rail

Status: done (d5fc4c6, prod 2026-09-05 07:03Z)

Maya via Chief, root dd69d0b2.

## Scope
- `GET /api/v1/user` workspaces gain `unread` (bool) and `mentions` (int) for the calling user's participant in
  each room, from the same read markers the channel badges use.
- Rail avatars show a mention count pill, else an unread dot; nothing when clean.
- Live: the current workspace clears its own badge on open (markers are already written by the channel read
  calls); other workspaces refresh on a timer that piggybacks the existing long-poll cycle: every 60 s, and at
  once when the tab regains focus, re-fetch `GET /api/v1/user` (cheap; one query). A per-room event stream
  needs a token per room, which the session does not have, so the poll is the stream here.

## Acceptance
- Go tests: `TestUserWorkspacesUnreadAndMentions` (a message in room B marks B unread for A's user; a mention
  counts; reading clears).
- `scripts/railbadge-check.js` (RAILBADGE_CHECK_OK): user A in two workspaces; user B posts a mention of A in
  workspace 2; A's rail shows "1" on workspace 2 within the refresh window (test triggers the focus refresh);
  A opens workspace 2 and the badge is gone. Screenshots.
