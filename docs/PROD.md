# Prod deployment (Mac mini `prodhost`)

Prod is a native launchd deployment on the Mac mini, fully separate from the
dev docker-compose instance. Deploys are deliberate: prod runs a pinned binary
and only moves when you run the deploy script.

| | dev (this machine) | prod (`prodhost`) |
|---|---|---|
| URL | http://localhost:8090 | http://192.168.1.33:8100 (LAN) |
| App | docker compose, every commit | pinned binary, manual deploys |
| Postgres | container, port 5477 | brew `postgresql@17` + pgvector, port 5432 (localhost only) |
| Data | docker volume | `/opt/homebrew/var/postgresql@17` |

## Layout on the mini

- `~/agentchat-prod/bin/agentchatd-<commit>` — one binary per deployed commit;
  `agentchatd` is a symlink to the live one (that symlink IS the version pin).
- `~/agentchat-prod/env` — `AGENTCHAT_DB_URL`, `AGENTCHAT_PORT=8100`,
  `AGENTCHAT_PUBLIC_URL`. Mode 0600; holds the db password. Add
  `OPENAI_API_KEY` here to enable semantic search (currently disabled).
- `~/agentchat-prod/logs/agentchatd.log` — app log.
- `~/Library/LaunchAgents/com.agentchat.prod.plist` — `RunAtLoad` +
  `KeepAlive`: starts at login and restarts on crash. The mini auto-logs-in
  as `prodhost`, which is what makes this survive reboots; if auto-login is
  ever turned off, convert to a LaunchDaemon.

Postgres runs via `brew services start postgresql@17` (also a login item).
Migrations are embedded in the binary and run on startup, so a deploy is just
a binary swap.

## Deploy / upgrade

From this repo, on the dev machine:

```sh
scripts/deploy-prod.sh            # deploys HEAD
scripts/deploy-prod.sh <commit>   # deploys a specific commit
```

The script builds `darwin/arm64` from a clean checkout of that commit, ships
it as `agentchatd-<commit>`, atomically repoints the symlink, kickstarts the
service, and curls `/healthz`. Roll back by re-running it with the previous
commit (old binaries stay in `bin/`).

## Ops crib sheet (on the mini)

```sh
tail -f ~/agentchat-prod/logs/agentchatd.log
launchctl kickstart -k gui/$(id -u)/com.agentchat.prod   # restart
launchctl bootout   gui/$(id -u)/com.agentchat.prod      # stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentchat.prod.plist  # start
/opt/homebrew/opt/postgresql@17/bin/psql -h localhost agentchat  # db shell
```

The macOS application firewall is disabled on the mini, so no allow rule is
needed for LAN access. The LAN IP `192.168.1.33` comes from the router's DHCP;
if it ever changes, update `AGENTCHAT_PUBLIC_URL` in `~/agentchat-prod/env`
and restart (existing room links embed the old IP).
