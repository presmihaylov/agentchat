# AgentChat — working rules

Single Go binary + Postgres (pgvector). Server code in `services/api`, storage in
`models`, web UI in `web/` (Vite app: `web/index.html`, `web/src`, vendor libs in
`web/public/vendor`; `npm run build` emits `web/dist`, embedded into the binary),
entrypoint `cmd/agentchatd`.

## Always write tests

Every new feature and every bug fix ships with tests in the same change. No exceptions.

- A bug fix gets a **regression test that fails without the fix** — write it, watch it
  fail on the unpatched code, then confirm the fix turns it green. If a fix is not
  observable in a test (e.g. crash-atomicity, temp-file cleanup), say so in the change
  and add the closest guarding test instead.
- Server/storage logic: Go tests in `services/api/*_test.go` (they hit a real Postgres).
- User-facing web behavior: a headless-Chrome e2e in `scripts/*-check.js` when reachable.
- "Done" means the whole suite is green, not just the new test.

## Build and test

```sh
go build ./...
# Go tests need a live Postgres (docker compose db, port 5477):
AGENTCHAT_DB_URL="postgres://agentchat:agentchat@localhost:5477/agentchat?sslmode=disable" \
  go test ./services/... ./models/... ./pkg/... -count=1
# Rebuild the dev app container (builds and serves the web UI too):
set -a && source .env && set +a && docker compose up -d --build app
bash scripts/e2e.sh                        # REST end-to-end (needs sourced .env)
SERVER=http://localhost:8095 bash scripts/cli-e2e.sh   # cli.sh end-to-end (CLI_E2E_OK)
# Browser e2e (needs puppeteer-core on NODE_PATH; every check makes its room through
# scripts/lib/login.js, whose newRoom() needs psql on PATH and the dev db, AGENTCHAT_DB_URL):
node scripts/ui-smoke.js                    # UI_SMOKE_OK
node scripts/url-check.js                   # URL_CHECK_OK
node scripts/replybar-check.js              # REPLYBAR_CHECK_OK
node scripts/msgsync-check.js               # MSGSYNC_CHECK_OK
node scripts/search-check.js                # SEARCH_CHECK_OK
node scripts/copy-check.js                  # COPY_CHECK_OK
node scripts/mention-check.js               # MENTION_CHECK_OK
node scripts/dnd-check.js                   # DND_CHECK_OK
node scripts/list-check.js                  # LIST_CHECK_OK
node scripts/attach-check.js                # ATTACH_CHECK_OK
node scripts/invite-check.js               # INVITE_CHECK_OK (ACCESS_ID/ACCESS_SECRET for a gated server)
node scripts/invitemenu-check.js           # INVITEMENU_CHECK_OK
node scripts/channeladd-check.js            # CHANNELADD_CHECK_OK
node scripts/moreactions-check.js           # MOREACTIONS_CHECK_OK
node scripts/chanlink-check.js              # CHANLINK_CHECK_OK
node scripts/notify-check.js                # NOTIFY_CHECK_OK
node scripts/archive-check.js               # ARCHIVE_CHECK_OK
node scripts/emoji-check.js                 # EMOJI_CHECK_OK
node scripts/theme-check.js                 # THEME_CHECK_OK
node scripts/settings-check.js              # SETTINGS_CHECK_OK (same)
node scripts/wsavatar-check.js              # WSAVATAR_CHECK_OK
node scripts/rail-check.js                  # RAIL_CHECK_OK
node scripts/railbadge-check.js             # RAILBADGE_CHECK_OK
node scripts/wsdelete-check.js             # WSDELETE_CHECK_OK
node scripts/fleetroom-check.js            # FLEETROOM_CHECK_OK (no browser, no db)
node scripts/kick-check.js                 # KICK_CHECK_OK
node scripts/slug-check.js                 # SLUG_CHECK_OK
node scripts/reactions-check.js             # REACTIONS_CHECK_OK
node scripts/codeblock-check.js             # CODEBLOCK_CHECK_OK
node scripts/docpreview-check.js           # DOCPREVIEW_CHECK_OK
node scripts/login-check.js                # LOGIN_CHECK_OK (needs AGENTCHAT_DB_URL for agentchat-passwd)
node scripts/settings-nav-check.js         # SETTINGS_NAV_CHECK_OK (same)
node scripts/enter-check.js                # ENTER_CHECK_OK
node scripts/dateseps-check.js             # DATESEPS_CHECK_OK
node scripts/switcher-check.js             # SWITCHER_CHECK_OK (same)
node scripts/composer-check.js             # COMPOSER_CHECK_OK
node scripts/chanrename-check.js           # CHANRENAME_CHECK_OK
node scripts/boot-check.js                 # BOOT_CHECK_OK (throttled boot: no layout flash)
node scripts/deliverystats-check.js        # DELIVERYSTATS_CHECK_OK (profile delivery row, task 25)
node scripts/ttl-check.js                  # TTL_CHECK_OK (workspace/channel expiry, task 26)
```

## Conventions

- Every event-writing transaction takes the room advisory lock **first**
  (`lockRoomEvents`), before any FK row lock, or it deadlocks AB-BA against
  `RotateSecret`. The UPDATE/INSERT and its `appendEventTx` go in one transaction.
- The invite code is a secret; the room slug is not. Only admins ever see the code.
- Never log or embed a secret (invite code, token) in an event payload.

## Prod

Native launchd deploy on a Mac mini; see `docs/PROD.md`. Deploys are deliberate:
`scripts/deploy-prod.sh <commit>`.
