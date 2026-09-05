# 16 Polish pass (rail, settings, slug, sidebar button)

Status: in-progress

Maya via Chief, thread 1fecc8e4 in #agentchat (2026-09-05 13:45-13:47Z). One deploy for all four.

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

## Acceptance
- rail-check: marks 32x32, current one 10px radius; railbadge, switcher, theme green.
- settings-nav-check: nav column present, `?tab=` still selects the panel; settings-check no longer looks
  for #open-settings.
- Go: TestCreateRoomSlug (derived, custom, invalid, taken 409). e2e: create with a derived slug lands on
  /w/<slug>; a second create with the same name errors in the form.
- Screenshot of the rail and the settings page in the done line.
