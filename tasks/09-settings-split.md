# 09 One settings place: Workspace settings and Personal settings

Status: todo

Maya via Chief, root 948f9802 in #agentchat (2026-09-04). Process note 1a7ee18d.

## Scope
- A single settings entry point at the top of the sidebar (the workspace menu keeps "Settings"; the app-bar
  `#app-signout` button and the profile-modal settings move under it). No other settings page remains:
  `#profile-actions` and `#notify-settings` leave the profile modal, `/settings` becomes the one page.
- `/settings` gets two tabs. **Workspace** (admins only, per the current workspace from `?ws=<slug>`):
  name (PATCH /api/v1/room, exists), avatar (task 11 adds it; this task leaves a placeholder-free section),
  slug (read-only, shown with a copy button; changing a slug breaks every link and every agent env file, so
  it stays fixed), invite code (show once on click, "Regenerate" calls POST /api/v1/room/rotate-secret, exists).
  Non-admins see the name and the slug, read-only. No model settings exist, so none are shown.
- **Personal**: username (read-only: no change endpoint exists, see question 1), password change (moved from
  today's page, the `must_change_password` banner still links here), avatar (per-workspace participant avatar,
  upload/remove, moved from the profile modal, labelled "Avatar in <workspace>"), notifications + theme + archive
  (moved from the profile modal), sign out.
- Room pages keep `#app-signout` only on the account pages; inside a room, sign out lives in Personal settings
  and in the workspace menu (unchanged).

## Acceptance
- Go tests: none new unless a handler changes; `rotate-secret` and `PATCH /room` keep their tests.
- `scripts/settings-check.js` (SETTINGS_CHECK_OK): admin sees both tabs, renames the workspace and the sidebar
  header follows, regenerates the invite and the old code is dead on /enter, non-admin sees Workspace read-only;
  Personal changes the password and the avatar and toggles notifications; the profile modal has no settings left;
  the only settings links in the DOM are the sidebar entry and the menu item. Screenshots of both tabs.
- `settings-nav-check.js` and `switcher-check.js` still green. Verified on prod as omar.

## Questions for Maya (proceeding on the recommendation)
1. Username change: there is no endpoint and agents mention humans by name. Recommend read-only now; a rename
   endpoint is its own task if wanted.
2. Avatar is per workspace today (participants table), not per account. Recommend keeping it per workspace and
   labelling it so; a per-account avatar means a users column and a migration.
