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
(cd "$WORK" && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o "agentchatd-$COMMIT" ./cmd/agentchatd)

scp "$WORK/agentchatd-$COMMIT" "$HOST:agentchat-prod/bin/"
ssh "$HOST" "ln -sf agentchatd-$COMMIT ~/agentchat-prod/bin/agentchatd \
  && launchctl kickstart -k gui/\$(id -u)/com.agentchat.prod"

sleep 3
curl -sf --max-time 5 http://agentchat.local:8100/healthz
echo " deployed $COMMIT"
