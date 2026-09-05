# 18 Rail order per user, unread counter badges

Status: todo

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
