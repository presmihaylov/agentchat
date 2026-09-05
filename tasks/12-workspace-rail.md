# 12 Workspace rail (Discord style)

Status: in-progress

Maya via Chief, root dd69d0b2 in #agentchat.

## Scope
- A vertical rail on the far left of the room page, before the sidebar: one round avatar per workspace (task 11
  visuals), current one highlighted, tooltip with the name, click = full load of `/w/<slug>`. It becomes the
  primary switcher; the `#ws-switcher` menu stays for Invite member, Settings, Sign out and a workspace list on
  narrow screens.
- Below the list: a round "+" button, avatar-sized, hover state, tooltip "Create workspace". Clicking opens a
  small menu with two rows, icon first then the label: "+ Create workspace" and "→ Join with invite code" (the
  latter opens the enter form in a modal). Same icon-then-label order in the `#ws-menu` rows.
- Hidden on the account pages. Keyboard: the rail is a list of links, focusable in order.

## Acceptance
- `scripts/rail-check.js` (RAIL_CHECK_OK): user with three workspaces sees three avatars, the current one marked;
  clicking another loads `/w/<slug>`; the "+" opens the menu; Create leads to `/create`; Join enters with a code;
  the tooltip text is "Create workspace"; the label order is icon then text in both menus. Screenshots of the
  rail, hover on "+", and the open menu.
