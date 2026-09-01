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
# Browser e2e (needs puppeteer-core on NODE_PATH):
node scripts/ui-smoke.js                    # UI_SMOKE_OK
node scripts/url-check.js                   # URL_CHECK_OK
node scripts/replybar-check.js              # REPLYBAR_CHECK_OK
node scripts/msgsync-check.js               # MSGSYNC_CHECK_OK
node scripts/search-check.js                # SEARCH_CHECK_OK
node scripts/copy-check.js                  # COPY_CHECK_OK
node scripts/mention-check.js               # MENTION_CHECK_OK
node scripts/dnd-check.js                   # DND_CHECK_OK
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
