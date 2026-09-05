# 16 Polish pass (rail, settings, slug, sidebar button)

Status: in-progress

Maya via Chief, thread 1fecc8e4 in #agentchat (2026-09-05 13:45-13:47Z). One deploy for all nine (three more came in at 13:5xZ, the thread rows at 14:4xZ, the profile row at 15:0xZ).

## Scope
- Rail (12): marks 32px (were 44px CSS, ~88px on a 2x screen), rail 52px wide, tighter gaps, a translucent
  hue tint with the initials in the hue and a lighter weight, smaller font; the + button and the current
  pill sized the same; badges stay legible (dot 8px, count 16px).
- Settings (09): Workspace / Personal as a left nav column inside the settings card, content on the right,
  same URL `?tab=` contract; typography from the room UI (15px body, 13px labels, 12px hints, sidebar
  heading style for the nav) via the existing variables, no new tokens.
- Create workspace: the slug is derived from the name (lowercase, hyphens, ASCII-folded, trimmed) with a
  live editable preview under the name; a taken slug is a 409 `slug_taken` on the API and a clear error in
  the form, no automatic suffix. Existing slugs untouched. The API accepts an optional `slug`; without it
  the server derives one from the name.
- Sidebar: the "⚙ settings" button under the search box goes away; settings is reached from the workspace
  picker menu only.
- Sidebar header: no workspace avatar; the header keeps the name and the caret, the avatar lives in the
  rail only.
- Participants: the collapsed agent-count pill reads `online/total` (e.g. `3/9`), the online part in the
  online green, the total dimmer; `0/9` dims the whole pill; tooltip "3 of 9 agents online"; no louder
  than the old pill.
- Channel icons: the muted mark is a monochrome bell-slash (masked SVG in the sidebar's dim colour, 12px,
  same size as the # glyph); the private lock is an inline SVG in the row's own colour; no emoji colour
  in the list or the channel title.
- Thread rows under a channel: no 🧵 and no vertical bar; a thin monochrome tree connector in the muted
  text colour, ├ for the rows above and └ for the last one, the title slightly indented after it; a muted
  thread shows the same bell-slash as a muted channel.
- Profile row at the bottom of the sidebar, like the Plain app's: a full-width row, a 40px rounded-square
  avatar with the online dot on its bottom-right corner, the full name in medium weight (no "(admin)"),
  no chevron (Maya's correction 6c824b3b), a hover background and pointer cursor say it is clickable, a
  thin divider above. The click opens the personal menu above the row: View profile, Settings (Personal
  tab), Sign out.
- No colour emoji as UI icons anywhere in the chrome (Maya, msg 302c5cd5): the search bar magnifier, the
  members button, the attach clips, the message actions (reply, edit, delete), the attachment chip, the
  broadcast marker, the "Copy agent instructions" button and the app brand / page headings become
  monochrome inline SVGs in currentColor. Avatars, reactions and message content keep their emoji.
- App logo (Maya, msg ac5c8834): `web/public/brand/agentchat-logo.png` is the canonical asset (two smiling
  speech bubbles on cream, 1254px). Generated from it: `agentchat-logo-mark.png` (cream trimmed to
  transparent, 512px, for every inline mark and dark surfaces), `favicon-16/32/64.png` (transparent; 64 is
  the base the task-18 favicon badge draws over), `favicon.ico`, `apple-touch-icon.png` (180px, kept on
  cream: iOS flattens alpha). Used at: the browser tab icon, the boot splash (a new full-screen logo shown
  until the first view unhides), the app header brand, the login / register / registration-closed /
  settings / create headings, the "no workspace" card and the enter-workspace heading. No SVG: the source
  is a raster, so there is no vector to derive.
- Header menu (Maya, msg c61adc39): the workspace dropdown lists no workspaces any more, the rail is the
  switcher. The workspace rows and the divider go; it keeps the workspace actions only: Invite member
  (admins), Create workspace, Join with invite code, Settings. Sign out moved to the personal menu. The
  header keeps the name + caret as the entry to the actions menu.
- Selection (Maya, msg c81f5501): the hover toolbar, the hover timestamp, the date separators, the reaction
  pills, the members count, the participants list and the channel list are `user-select: none`; a drag only
  ever grabs message content.
- Toolbar icons (Maya, msg 32de034e): react / reply / edit / delete / more are Lucide smile-plus /
  message-square / pencil / trash-2 / more-vertical in the muted colour, accent on hover. There is no
  bookmark action in the toolbar (nothing to bookmark yet), so no bookmark icon.
- Participants (Maya, msg 8f8ed1a0): the members button already carries the users SVG; the expand chevrons
  (rows, offline divider, channel section headers) are Lucide chevron-right / chevron-down; status stays a
  plain dot; the whole list is `user-select: none`.
- Composer (Maya, msg 42e8199f): one rounded border around the editor and an action bar; the Lucide paperclip
  sits inside at the bottom-left, the compact Lucide arrow-up send button inside at the bottom-right, accent
  with text and muted (`.empty`) without; the editor grows upward to 40vh; an `Enter to send, Shift+Enter
  new line` hint sits in the bar. Structure taken from claudecontrol's MessageComposer (box, editor,
  pending files row, bottom bar with attach + kbd hint + send), not its visual design.
- Date separators (Maya, msg c6b018d1, pick 60bc5419): no pill. Plain muted text (the timestamp colour, 11px, weight 500)
  centred between two hairlines; the sticky copy keeps only a page-coloured backdrop so it stays readable
  over the messages it floats above. The unread divider was already a plain line, unchanged.

## Acceptance
- rail-check: marks 32x32, current one 10px radius; railbadge, switcher, theme green.
- settings-nav-check: nav column present, `?tab=` still selects the panel; settings-check no longer looks
  for #open-settings.
- Go: TestCreateRoomSlug (derived, custom, invalid, taken 409). e2e: create with a derived slug lands on
  /w/<slug>; a second create with the same name errors in the form.
- wsavatar-check reads the rail mark (the header span is gone); roster-check accepts `n/2`; privacy,
  private, channeladd, membership, mentionbadge read `.chan-name` / `.sigil-lock`.
- login-check: the sign-in heading carries the logo mark (loaded, natural size > 0) and the tab icon links
  point at /brand/favicon-32.png; ui-smoke: the splash is gone once the room renders; moreactions-check: the
  toolbar buttons hold SVG icons, not literal template text.
- composer-check: inline paperclip + arrow-up inside the border, `.empty` toggles with text, the box grows
  upward on Shift+Enter, the bar is unselectable, the inline send posts; moreactions-check reads the Lucide
  icon names and the toolbar's `user-select`; reactions / roster read the Lucide icons.
- dateseps-check: the separator span has no border, no background, 11px, weight <= 500; verified on prod in
  dark and light with screenshots.
- Screenshot of the rail, the settings page, the profile row menu and the login page in the done line.
