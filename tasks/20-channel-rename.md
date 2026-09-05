# 20 Channel rename (admins), with a system entry

Status: done (63705a7, prod 2026-09-05 ~17:30Z, verified as omar on prod)

Maya via Chief, root 8ae92fc5 in #agentchat (2026-09-05 14:20Z) and the addendum 5676be6e. Own deploy,
right after the polish pass (16), before 17.

Part 1 was done by hand on prod at 14:2xZ (reply 92a6d6fb): `UPDATE channels SET name='data' WHERE
id='e0193556-...' AND name='data-questions'` in one transaction. Channels have no slug column; the name is
the key (unique per room).

## Scope
- API: `PATCH /api/v1/channels/{id}` accepts `name` (admins only, same validation as create: the channel
  name rules and reserved names; `general` cannot be renamed). A taken name is 409 `name_taken`. The
  update and its event go in one transaction under the room advisory lock.
- Event: `channel.renamed` with channel_id, old name, new name, actor. Delivered to every member of the
  room like `channel.privacy_changed` (the sidebar of non-members that can see the channel also changes).
- System entry: a `kind: system` message in the channel, "<Name> renamed the channel from #old to #new",
  the same styling as the join/invite entries, through the normal event stream so agents see it.
- UI: admins rename from the channel header (a pencil next to the name or the channel menu) and from the
  channel settings if one exists; the sidebar, the title and open composer chips update live from the
  event; links in old messages (`#old`) are not rewritten.
- CLI/skill: document the field; `cli.sh` gets no new verb (PATCH body).
- Folded in by Chief for the same deploy:
  - Bug first (msg 62883447, Maya): on initial load the app briefly paints the pre-workspaces layout
    (old header / picker chrome) before the rail and picker are ready, then snaps. Fix: until the
    session, the member workspaces and the current workspace are all loaded, only the splash / a neutral
    skeleton (rail placeholder circles, sidebar and timeline skeleton) shows on the theme background; the
    real UI paints once, never a non-final layout for a single frame. Covers hard refresh, /w/<slug>
    deep links and the /login redirect. Reproduce with a throttled network first; a throttled reload
    screenshot sequence goes in the done line. Task 23's prefetch store stays in 23 unless it is the fix.
  - Sticky day label (msg 82b8a4be): the stuck date separator pins to the top edge of the scroll area, not
    ~22px inside it (scroll padding + divider margin, since dfe28be).
  - Red unread badge (msg 4561407a): the rail count badge and the mention pills are a clear red
    (Discord-style, ~#ED4245 on dark, a deeper red on light), white bold count, same size and ring. The
    plain unread dot stays. Muted workspaces keep a grey pill (task 18).
  - Sidebar typography (msg 6726d1bf): one scale for the whole left sidebar: header 15px/600, section
    labels 11px uppercase 600 (h3, channel sections, participant groups, offline toggle), rows 14px,
    thread leaves 13px, secondary text 12px muted, profile row name 14px/500 with the channel rows' left
    padding. The 40px avatar stays (Maya's earlier spec), so the profile row is taller than a channel row.
    Before/after screenshot in the done line.
  - Settings design pass (msg b41f2a20, Maya): Personal tab order Avatar, Notifications, Appearance,
    Change password, Sign out last. Type scale from the app: labels and inputs at body size (15px), section
    labels one step smaller in caps and muted, page title one step above body; inputs and buttons at the
    composer's height. Content column capped ~560px, everything left-aligned, avatar + its two small
    secondary buttons in one row; no full-width primary buttons (Change password a normal-width secondary
    button under its fields, Sign out a ghost/text button). Labels: "Avatar" (or "Avatar in this workspace"
    once, helper size), the username shown as a small muted line, "Desktop notifications", "Sound", the
    permission prose replaced by an inline "Allow in browser" link shown only while permission is not
    granted. Workspace tab the same treatment (name, avatar, slug, members, danger zone last). Left nav in
    the sidebar row style, not big pills. Dark and light verified, before/after of both tabs in the done line.
  - Agent count pill (msg 97bae450, Maya): the `online/total` pill next to a participant is monochrome muted:
    muted grey text on a very faint fill or none, the online part in the normal secondary colour, no green,
    no coloured border. The status dot carries the state; the pill carries only the numbers.
  - Rail mark size (msg 21130955, Maya): back to the pre-5c8dc0c size, marks 44px in a 64px rail; the +
    button and the current pill scale with it; the muted styling, spacing and badges from the polish stay.
- Same system entry for the other admin actions where a channel context exists: member removed from a
  channel already posts "was removed by Y" (models/channels.go); a workspace kick (task 15) and a
  workspace rename get one in #general: "<Name> removed Omar from the workspace", "<Name> renamed the
  workspace from X to Y".

## Acceptance
- Go: rename happy path, non-admin 403, general 409 (the existing PATCH rule), taken 409 `name_taken`, reserved/invalid 400, the system message
  exists in the channel and carries the actor, the event carries old and new names.
- Browser: scripts/chanrename-check.js: admin renames from the header, the sidebar row and the title change
  live in a second (member) tab, the system entry shows in both, the member sees no rename control.
- Prod: rename a scratch channel in a test workspace and back; the acme untouched.
- dateseps-check: the stuck marker sits at the box's top edge; railbadge-check reads the red; a sidebar
  typography assertion in rail-check or roster-check (h3 11px, rows 14px, profile row 14px/500).

## (13) Browser tab title (Chief for Maya, msg e5bb2b28)
`AgentChat | <Workspace name>` inside a workspace (was just the workspace name); the unread prefix stays in
front, `(3) AgentChat | Acme Team`, ready for the task-18 favicon badge; plain `AgentChat` on login, join,
settings and create. Updates on a workspace switch and live on a workspace rename (`room.renamed` now repaints
the header, the switcher, the rail and the title). switcher-check asserts all three.

## (14) cli.sh --body-file and stdin bodies (Chief for Maya, msg 4f9a9a80)

- `--body-file <path>` on send/reply/broadcast; `-` (as the path or as the body argument) reads stdin. Old inline bodies keep working.
- VERSION 1.6.0 -> 1.7.0.
- /skill and /skill/claude-code: one explicit paragraph under sending: long or quote/backtick/$-heavy bodies go via --body-file, never inline; the `"$(cat msg.md)"` advice is gone.
- cli-e2e.sh: round-trip a quote/backtick/$ body via --body-file, stdin `-`, and a bare `-`; a missing file exits non-zero.
