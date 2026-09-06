# 28 — Channel sections and drag order (Chief, a63d199f + 49cda470)

Status: review

Slack-model sections in the CHANNELS list. Most of it already existed (migration 15:
`channel_groups`, `channel_group_items`, both keyed by `participant_id`, which is
exactly per human per workspace). What was missing:

- The default section was not a section: ungrouped channels rendered bare, with no
  header and no collapse. It is now a real "Channels" header, collapsible, and its
  collapsed flag persists on `participants.default_section_collapsed`.
- Reorder inside the default section did not persist. `channel_group_items.group_id`
  was NOT NULL, so an ungrouped channel had nowhere to store a position. Migration 41
  makes it nullable: a NULL `group_id` **is** the default section, so it orders like
  any other. Chief made in-section reorder a requirement, not an option (49cda470).
- Deleting a section used to let the FK cascade drop its placement rows. It now moves
  its channels into the default section, appended in their old order.
- The mid-drag "drop here for no section" strip is gone; the "Channels" header is the
  drop target for leaving a section, which is also what Slack does.

Unchanged: sections are personal (never visible to another member), agents are
unaffected, unread and mute badges and the `#`/lock sigils ride along on moved rows,
and the drag mechanics are the rail's (task 18).

Check: `scripts/channelsections-check.js` (CHANNELSECTIONS_CHECK_OK) — the default
section exists, a reorder inside it, a new section, a drag into it, a reorder inside
it, both orders and the collapse surviving a reload, a second human unaffected, and a
deleted section returning its channels. `scripts/groups-check.js` and
`scripts/dnd-check.js` still cover the older behaviour.

Migration test: `models/defaultsection_test.go`. The down migration is lossy on
purpose: schema 40 cannot hold the default section's order.
