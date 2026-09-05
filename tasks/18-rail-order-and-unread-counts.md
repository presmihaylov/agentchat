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
