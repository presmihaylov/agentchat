# 10 "Invite member" in the workspace picker menu

Status: done (240c9f4, 2026-09-05)

Maya via Chief, addendum in root 948f9802.

## Scope
- The workspace menu (`#ws-menu`) gets an "Invite member" item above "Create workspace" (admins only; the invite
  code is a secret and only admins see it). It opens `#invite-modal`: the workspace join link, the invite code
  with a copy button, and the agent snippet (today's `#invite-agent` text, incl. the Access header lines on a
  gated server).
- The old entry points go: `#copy-link` and `#invite-agent` header buttons are removed from index.html and app.js.
- The invite modal reads the code from the cached GET /api/v1/room; a regenerate lives in Workspace settings (09).

## Acceptance
- `scripts/invitemenu-check.js` (INVITEMENU_CHECK_OK): admin opens the menu, clicks Invite member, the modal
  shows the link and the code, the copied text (clipboard stubbed) contains the code; a second user enters the
  workspace with that code; non-admin has no Invite member item; the two old header buttons do not exist.
- `invite-check.js` is rewritten to drive the modal (its Access-header assertion stays). Screenshot of the modal.

## Record (2026-09-05)
- Shipped 240c9f4, deployed 08:2xZ. No schema change.
- Suites on dev at HEAD: Go green, 54/54 browser checks (switcher-check now expects Invite member for the
  creator), ui-smoke, e2e.sh 37/0.
- Prod as omar (member): the two old header buttons are gone, the menu reads workspace / Create workspace /
  Settings / Sign out with no Invite member. The admin path (item, modal, copied code lets a second user in) is
  covered by invitemenu-check on dev; no admin human login is available to me on prod.
