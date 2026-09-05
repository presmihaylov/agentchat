# 18 Rail order per user, unread counter badges

Status: done (see the shipping commit in git log, 2026-09-06)

Maya via Chief, root d4c931ea in #agentchat (2026-09-05 13:50Z). Own deploy, after invite links (17).

## Scope
- Drag and drop the workspace marks in the rail. The order is per user, stored on the account
  (`users.workspace_order` or a `user_workspace_order` table), persisted server-side, applied to the
  rail and the picker menu. Keyboard fallback: move up / move down.
- Unread badge shows a number: the total unread messages across the workspace's channels (mutes
  respected). Mentions stay distinct (red pill); plain unreads get a neutral pill. Display caps at 99+.

## Acceptance
- Go: order endpoint (PATCH /api/v1/user/workspace-order), validated against membership, per user.
- Browser e2e: drag reorders and survives a reload; another member keeps their own order; the badge
  shows the unread count, a mention turns it red, 100 unreads read 99+.

## Added 2026-09-05 14:3xZ: mute a whole workspace (Maya via Chief, msg 9100a582)
- Per-user setting on the account, like channel mutes: toggled from a right-click / context menu on a rail
  mark and from Workspace settings > Personal.
- A muted workspace sends no notifications (browser notification, title flash, sound), but the rail badge
  still shows the count, in a neutral gray pill (no red for mentions, no unread colour). Unmute restores the
  colours. The mark's tooltip says "Muted".
- Acceptance: railbadge / rail checks cover the gray pill and the tooltip; a mentions notification does not
  fire for a muted workspace; the Personal panel shows the toggle with the current state.

## Addendum: favicon and tab-title unread badge (Maya via Chief, msg c78ca141, 2026-09-05 14:36Z)

Discord-style. Draw the favicon at runtime on a canvas with a red count pill bottom-right: the unread
total across all non-muted workspaces and non-muted channels, mentions included, capped at 99+. Prefix
the document title with the count in parentheses, e.g. `(153) AgentChat`. Zero unread: plain favicon,
plain title. Update live from the same badge feed the rail uses, plus on tab focus. Muted workspaces and
muted channels never count.

## Design (as shipped)

- Schema 000034 `user_room_prefs (user_id, room_id, position, muted)`, PK (user, room), cascades on
  both. Account-level: survives leave-and-rejoin, invisible to other members.
- `GET /api/v1/user` lists workspaces in `position NULLS LAST, joined_at` order and carries
  `unread_count` (plain unread total, the sidebar rule: a muted channel counts only its mentions and
  broadcasts), `mentions`, `unread` (bool, kept) and `muted`.
- `PATCH /api/v1/user/workspace-order {order:[ids]}`: 1-200 distinct ids, every one a live
  membership (403 `not_a_member` otherwise, nothing changes); listed rooms get 0..n, unlisted ones
  lose their position and sort after. Answers the reordered list.
- `PATCH /api/v1/user/workspaces/<id> {muted}`: live membership only, answers the workspace entry.
- Rail: marks are `draggable`; dragover moves the dragged mark live, drop saves the DOM order.
  Right-click (or Shift+F10 on a focused mark) opens `#rail-ctx`: Move up, Move down, Mute/Unmute
  workspace. Alt+ArrowUp/Down moves a focused mark. Both session-only, no agent surface.
- Badges: `.rail-badge.count` neutral pill with the unread count; `.mention` red with the mention
  count; `.muted` gray with the count, never red; the mark dims and its tooltip reads
  "<name> (Muted)". 99+ cap. The current mark stays clean (its channel list is the live truth).
- Mute: `notifyReason` returns null when the open workspace is muted (no sound, no browser
  notification, no title count). Settings > Personal > Workspace has the toggle for the workspace
  the page came from.
- Favicon + title: `unreadTotal()` = non-muted other workspaces' `unread_count` from the rail feed
  plus the open room's live channel counts (muted channels: mentions only). Title `(N) AgentChat |
  name` uncapped; favicon drawn on a 32px canvas over the shipped mark with a red 99+-capped pill.
  Refreshed on every channel render, every rail poll (60 s) and on tab focus.
- Checks: `scripts/railorder-check.js` (drag, reload, other member's order, Alt+Arrow, context
  menu mute: gray pill, tooltip, no notification, title; Settings toggle), `scripts/railbadge-check.js`
  (neutral 1, red mention, 99+, title, favicon data URL). Go: `TestWorkspaceOrderAndMute`.
