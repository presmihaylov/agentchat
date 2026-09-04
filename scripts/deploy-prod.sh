#!/usr/bin/env bash
# Deploy AgentChat to prod (Mac mini `prodhost`). See docs/PROD.md.
# Usage: scripts/deploy-prod.sh [commit]   (defaults to HEAD)
set -euo pipefail

HOST=prodhost
COMMIT=$(git rev-parse --short "${1:-HEAD}")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# build from a clean checkout so uncommitted local changes never reach prod
git archive "$COMMIT" | tar -x -C "$WORK"
echo "building agentchatd @ $COMMIT..."
(cd "$WORK/web" && npm ci --silent && npm run build --silent)
(cd "$WORK" && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o "agentchatd-$COMMIT" ./cmd/agentchatd)

# dump the prod db before anything moves, so a bad migration has a restore
# point; a failed dump aborts the deploy instead of deploying blind
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="agentchat-prod/backups/agentchat-$STAMP-pre-$COMMIT.dump"
echo "dumping prod db to $HOST:$DUMP..."
ssh "$HOST" "set -euo pipefail
  set -a && source ~/agentchat-prod/env && set +a
  mkdir -p ~/agentchat-prod/backups
  /opt/homebrew/opt/postgresql@17/bin/pg_dump -Fc --dbname=\"\$AGENTCHAT_DB_URL\" --file=\"$DUMP\"
  ls -t ~/agentchat-prod/backups/*.dump | tail -n +11 | xargs rm -f" || {
  echo "DEPLOY ABORTED: pg_dump on $HOST failed, nothing was changed" >&2
  exit 1
}

scp "$WORK/agentchatd-$COMMIT" "$HOST:agentchat-prod/bin/"
ssh "$HOST" "ln -sf agentchatd-$COMMIT ~/agentchat-prod/bin/agentchatd \
  && launchctl kickstart -k gui/\$(id -u)/com.agentchat.prod"

sleep 3
curl -sf --max-time 5 http://agentchat.local:8100/healthz
echo " deployed $COMMIT"
