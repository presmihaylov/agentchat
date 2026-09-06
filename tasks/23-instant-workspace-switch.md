# 23 Instant, whole workspace switching

Status: in progress

Maya via Chief, root 9ffa4450 in #agentchat (2026-09-05 14:57Z). After 18 (same rail/switch code).

## Scope
1. No staggered render. Today the header, channel list, participants and messages each pop in as their
   request returns. Replace with (a) a single skeleton for the whole workspace pane until the switch's
   critical data (workspace, channels, current channel's latest messages, participants) has all arrived,
   then one render; or (b) keep the previous workspace on screen with a thin progress bar until the new one
   is fully ready, then swap atomically. Prefer (b) when coming from another workspace, (a) on first load.
2. Preload and cache every workspace the user belongs to. On login/boot fetch the membership list once, then
   warm each workspace's channels, participants and the latest page of messages per channel in the
   background, in one client store keyed by workspace. A switch reads from the store and renders
   immediately; the network only refreshes deltas. Keep the caches live: subscribe to events for all member
   workspaces in one connection (the badge feed already needs this), apply them to the store, so switching
   back never reloads. Bound memory (last N messages per channel, evict channels not opened for a while).
3. Rail badges and per-workspace unread counts derive from the shared store, not per-switch requests.

## Acceptance
- Switch between three workspaces on prod with the network throttled to Slow 3G; no element appears before
  the others; the second visit to a workspace renders with zero network requests before paint.
- Screenshots or a short recording in the done line.

## Design
- Server: `GET /api/v1/user/events?cursors=<slug>:<seq>,...&wait=25` (session auth, no workspace header).
  One long-poll for every workspace the account belongs to. Each room is scanned with the same
  ListEvents + filterEvents as `/api/v1/events`, events come back tagged `workspace: <slug>`, and the
  answer carries `cursors: {slug: seq}` for every member room. A slug without a cursor in the request
  gets its latest seq back with no events (that is how the client learns a new membership). Humans hold
  no delivery receipts, so nothing is marked delivered. The per-workspace `/api/v1/events` stays for agents.
- Client: one store keyed by slug. An entry holds me, room, admin flag, channels, groups, participants,
  public channels, threads, per-channel message pages (last 100, evicted after 30 min unopened except
  the entry's last channel) and the feed cursor. The module state the renderers read is the active entry;
  a switch saves the active entry, loads the target entry and paints every region in one synchronous pass
  (`swapTo`). No entry may reach the screen partially: a cold target is warmed off screen first
  (me, room, groups, public channels, threads, the target channel's page) while a thin progress bar
  runs on top of the old workspace, then swapped.
- Boot: first load keeps the splash (a) until the first workspace is whole. After the first paint the
  membership list is warmed one workspace at a time, then every channel page in the background with a
  small concurrency, lowest priority.
- Live: the feed loop applies active-workspace events through the existing `applyEvent`; events for a
  background workspace update its entry (message pages, unread counts, structural refresh of the entry's
  room, debounced). Rail badges are computed from the entries (a cold entry falls back to the /user counts);
  the 60 s /user poll is gone, /user is refetched only when the feed's slug set changes.
- Switch is a pushState to `/w/<slug>`; popstate switches back the same way.
- Out of scope: desktop notifications for background workspaces (badges only, as today).
