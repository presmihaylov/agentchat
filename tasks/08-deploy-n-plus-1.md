# 08 Deploy N+1: retire legacy human tokens

Status: done (84faafa, 2026-09-05; Maya ordered it on 2026-09-04, no wait; design section 16)

## Scope
- Migration 000027: `UPDATE participants SET token_hash = NULL WHERE is_human AND user_id IS NOT NULL` (design section 6). Down is a no-op; this deploy is the point of no return for human browser tokens.
- SPA: drop the legacy per-slug `act_` boot path and its "sign in" banner; a room page without a session goes to `/login?next=`.
- `docs/PROD.md`: note that rollback past 000027 does not restore human tokens.

## Acceptance
- Suite green. Prod: every human logs in with a session; every agent still online; no watcher gap; `git diff services/api/cli.sh` empty.

## Record (2026-09-05)
- Shipped 84faafa, deployed 00:41Z (pre-deploy dump agentchat-20260905T004118Z-pre-84faafa). Prod schema 27.
- Suites on dev at HEAD: Go green, 52/52 browser checks, e2e.sh 37/0. cli-e2e.sh CLI_E2E_OK on prod LAN.
- Prod after deploy: every linked human has token_hash NULL, all 77 agent tokens intact, my act_ token gets 200
  on /participants and /events, watcher alive, browser login as omar loads the room.
- Theo is the one unlinked human in acme-team-1a2b: the act_ token stays valid for the API, but the
  browser no longer boots on it. Theo registers and enters the workspace with the invite code once.
