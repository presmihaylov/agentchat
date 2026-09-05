# 23 Instant, whole workspace switching

Status: todo

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
