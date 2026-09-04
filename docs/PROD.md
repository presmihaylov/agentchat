# Prod deployment (Mac mini `prodhost`)

Prod is a native launchd deployment on the Mac mini, fully separate from the
dev docker-compose instance. Deploys are deliberate: prod runs a pinned binary
and only moves when you run the deploy script.

| | dev (this machine) | prod (`prodhost`) |
|---|---|---|
| URL | http://localhost:8090 | http://agentchat.local:8100 (LAN, mDNS); http://192.168.1.33:8100 fallback |
| App | docker compose, every commit | pinned binary, manual deploys |
| Postgres | container, port 5477 | brew `postgresql@17` + pgvector, port 5432 (localhost only) |
| Data | docker volume | `/opt/homebrew/var/postgresql@17` |

## Layout on the mini

- `~/agentchat-prod/bin/agentchatd-<commit>` — one binary per deployed commit;
  `agentchatd` is a symlink to the live one (that symlink IS the version pin).
- `~/agentchat-prod/env` — `AGENTCHAT_DB_URL`, `AGENTCHAT_PORT=8100`,
  `AGENTCHAT_PUBLIC_URL`. Mode 0600; holds the db password. Add
  `OPENAI_API_KEY` here to enable semantic search (currently disabled).
  To expose the room to chosen outsiders, add the `CLOUDFLARE_TUNNEL` block
  from `docs/CLOUDFLARE.md`.
- `~/agentchat-prod/logs/agentchatd.log` — app log.
- `~/agentchat-prod/backups/agentchat-<utc stamp>-pre-<commit>.dump` — a
  `pg_dump -Fc` the deploy script takes before every binary swap. The newest
  10 are kept. Restore with `pg_restore --clean --if-exists -d <db url> <file>`.
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

The script first builds the web UI (`npm ci && npm run build` in `web/`, so
node is a build-time dependency on the dev machine only; nothing new runs on
the mini), then builds `darwin/arm64` from a clean checkout of that commit, ships
it as `agentchatd-<commit>`, atomically repoints the symlink, kickstarts the
service, and curls `/healthz`. Before the binary swap it takes a `pg_dump` on
the mini (see `backups/` above) and aborts if the dump fails.

## Rollback

Migrations only move forward on startup, and an old binary refuses to open a
database whose version is above the migrations it embeds. So a rollback that
crosses a migration is two steps, run with the currently deployed binary first:

```sh
# on the mini, with the env file loaded
set -a && source ~/agentchat-prod/env && set +a
~/agentchat-prod/bin/agentchatd -migrate-to <version embedded in the target commit>
# then, from the dev machine
scripts/deploy-prod.sh <target commit>
```

`-migrate-to` runs the down files above the target, prints the resulting
version and exits without serving. Rolling back across a migration deletes the
data those tables held (for example 24 to 23 deletes every user account and
session). A rollback that crosses no migration is just the deploy line with
the older commit (old binaries stay in `bin/`).

## Task 04 deploy: the user backfill (migration 000026)

Migration 000026 turns every legacy human participant into a user account
(design: `docs/workspaces-auth-design.md` section 7). Default password
`developer`, `must_change_password` set, so everyone sees the banner on first
login. Agents are untouched.

1. Preview, read-only, on the mini with the current (schema 25) binary:
   ```sh
   set -a && source ~/agentchat-prod/env && set +a
   /opt/homebrew/opt/postgresql@17/bin/psql "$AGENTCHAT_DB_URL" -f users-migration-preview.sql
   ```
   (`scp scripts/users-migration-preview.sql prodhost:` first.) Review the
   merge report (one username, several rows), the collision report (a derived
   username that a registered account with zero links already holds: the
   legacy row gets `-2` and a fresh account) and the pre-linked report (users
   the operator linked by hand, e.g. `maya`; their unlinked rows in other rooms
   merge into them). Fix a wrong merge by renaming the participant before the
   deploy.
2. `AGENTCHAT_DEPLOY_VERIFY_BACKFILL=1 scripts/deploy-prod.sh <commit>`. With
   the flag set, the script runs the four verification counts through psql on
   the mini after the health check and exits non-zero when any is not 0. Set
   the flag only on this deploy: humans who join with an invite code later are
   unlinked by design, so the first count is not an invariant afterwards.
3. Reopen registration: remove the `AGENTCHAT_REGISTRATION_ENABLED=false` line
   from `~/agentchat-prod/env` (the default is true) and
   `launchctl kickstart -k gui/$(id -u)/com.agentchat.prod`.

Rollback target is 25: `agentchatd -migrate-to 25` removes exactly the
accounts 000026 created (tracked in `users_backfill_000026`) and their links;
pre-linked and registered users stay. Then deploy the task 03 commit (without
the verify flag: the tracking table is gone).

## Ops crib sheet (on the mini)

```sh
tail -f ~/agentchat-prod/logs/agentchatd.log
launchctl kickstart -k gui/$(id -u)/com.agentchat.prod   # restart
launchctl bootout   gui/$(id -u)/com.agentchat.prod      # stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentchat.prod.plist  # start
/opt/homebrew/opt/postgresql@17/bin/psql -h localhost agentchat  # db shell
```

The macOS application firewall is disabled on the mini, so no allow rule is
needed for LAN access.

The canonical URL is `http://agentchat.local:8100`. It resolves via mDNS
(Bonjour) with zero config from any Apple device and most others on the WiFi.
The name comes from `scutil --set LocalHostName agentchat` on the mini, so it
follows the box across DHCP lease changes. `AGENTCHAT_PUBLIC_URL` in
`~/agentchat-prod/env` is set to this name, so room links embed it.

The raw LAN IP `http://192.168.1.33:8100` is a fallback for clients without
mDNS (some Android/Windows). That IP comes from the router's DHCP and can
change; the `.local` name does not, which is why it is canonical. If you ever
must pin to an IP instead, update `AGENTCHAT_PUBLIC_URL` and restart.
