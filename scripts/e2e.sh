#!/usr/bin/env bash
# End-to-end multi-agent simulation against a real server + docker Postgres.
# Usage: scripts/e2e.sh   (expects `make db-up` done; reads .env if present)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-8099}"
export AGENTCHAT_DB_URL="${AGENTCHAT_DB_URL:-postgres://agentchat:agentchat@localhost:5477/agentchat?sslmode=disable}"
export AGENTCHAT_PORT="$PORT"
export AGENTCHAT_PUBLIC_URL="http://localhost:$PORT"
export AGENTCHAT_HOME="$(mktemp -d)"
SERVER="http://localhost:$PORT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1" >&2; }
check() { # check <desc> <cmd...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi
}
expect_fail() { # expect_fail <desc> <cmd...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$desc (unexpectedly succeeded)"; else ok "$desc"; fi
}

echo "== build =="
go build -o bin/agentchat ./cmd/agentchat
go build -o bin/agentchatd ./cmd/agentchatd
CLI=./bin/agentchat

echo "== start server on :$PORT =="
./bin/agentchatd & SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null || true; rm -rf "$AGENTCHAT_HOME"; }
trap cleanup EXIT
for i in $(seq 1 30); do curl -sf "$SERVER/healthz" >/dev/null && break; sleep 0.3; done
curl -sf "$SERVER/healthz" >/dev/null || { echo "server did not start"; exit 1; }

echo "== room setup =="
CREATED=$($CLI create-room "e2e sim" --server "$SERVER")
LINK=$(echo "$CREATED" | awk '/join link/{print $3}')
CODE=$(echo "$CREATED" | awk '/^invite code:/{print $3}')
[ -n "$LINK" ] && [ -n "$CODE" ] && ok "room created ($LINK)" || fail "room created"
case "$LINK" in *"$CODE"*) fail "join link must not contain the invite code";; *) ok "invite code not in the link";; esac
$CLI join "$CODE" --server "$SERVER" --name orchestrator --description "coordinates the others" --profile orch >/dev/null
$CLI join "$CODE" --server "$SERVER" --name researcher --avatar 🔎 --description "digs up facts" --profile res >/dev/null
$CLI join "$CODE" --server "$SERVER" --name writer --avatar ✍️ --description "writes summaries" --profile wri >/dev/null
$CLI join "$CODE" --server "$SERVER" --name human-pm --human --avatar 🧑 --description "the human PM" --profile pm >/dev/null
ok "4 participants joined"
check "skill is served" curl -sf "$SERVER/skill"
check "web ui is served" curl -sf "$SERVER/r/anything"

echo "== roles =="
$CLI whoami --profile orch | grep -q '"role": "admin"' && ok "first joiner is admin" || fail "first joiner is admin"
$CLI whoami --profile res | grep -q '"role": "member"' && ok "later joiner is member" || fail "later joiner is member"
expect_fail "member cannot rename room" $CLI room-rename hacked --profile res
check "admin promotes human-pm" $CLI promote human-pm --profile orch

echo "== channels & chat =="
check "member creates #findings" $CLI channel-create findings --topic "research results" --profile res
MSG_ID=$($CLI post findings "kubernetes pods are being OOM-killed in prod" --profile res --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$MSG_ID" ] && ok "posted root message" || fail "posted root message"
check "threaded reply" $CLI post findings "digging into the memory limits now @writer" --thread "$MSG_ID" --profile res
check "mention + broadcast" $CLI post general "@channel summary due at noon" --profile orch
$CLI thread "$MSG_ID" --profile wri | grep -q "memory limits" && ok "thread readable" || fail "thread readable"
$CLI messages findings --profile pm | grep -q "OOM-killed" && ok "history readable" || fail "history readable"

echo "== attachments =="
echo "memory usage report: 97% on node-3" > "$AGENTCHAT_HOME/report.txt"
ATT_ID=$($CLI upload "$AGENTCHAT_HOME/report.txt" --profile res)
[ -n "$ATT_ID" ] && ok "uploaded" || fail "uploaded"
check "post with attachment" $CLI post findings "full report attached" --attach "$AGENTCHAT_HOME/report.txt" --profile res
$CLI download "$ATT_ID" --profile wri | grep -q "node-3" && ok "download roundtrip" || fail "download roundtrip"

echo "== tags & presence =="
check "tagging" $CLI tag writer summarizer --profile orch
$CLI participants --profile orch | grep -q "summarizer" && ok "tag visible" || fail "tag visible"
$CLI participants --profile orch | grep -q "researcher (agent, online)" && ok "presence online" || fail "presence online"
check "go offline" $CLI offline --profile wri

echo "== monitoring =="
OUT=$( ($CLI monitor --once --profile orch & sleep 1; $CLI post general "monitor ping two" --profile res >/dev/null; wait) 2>/dev/null )
echo "$OUT" | grep -q "monitor ping two" && ok "long-poll monitor delivers events" || fail "long-poll monitor delivers events"

echo "== search =="
sleep 1
$CLI search "OOM-killed" --profile pm | grep -q "OOM-killed" && ok "full-text search" || fail "full-text search"
$CLI search "OOM-killed" --channel general --profile pm | grep -q "no results" && ok "channel filter excludes" || fail "channel filter excludes"
$CLI search "OOM-killed" --author researcher --profile pm | grep -q "OOM" && ok "author filter" || fail "author filter"
if [ -n "${OPENAI_API_KEY:-}" ]; then
  for i in $(seq 1 20); do
    $CLI search "container memory problems" --semantic --profile pm 2>/dev/null | grep -q "OOM" && break; sleep 1
  done
  $CLI search "container memory problems" --semantic --profile pm | grep -q "OOM" && ok "semantic search" || fail "semantic search"
else
  echo "  skip: semantic search (no OPENAI_API_KEY)"
fi

echo "== moderation =="
check "author edits own message" $CLI edit "$MSG_ID" "kubernetes pods OOM-killed (edited: confirmed)" --profile res
expect_fail "non-author cannot edit" $CLI edit "$MSG_ID" "vandalism" --profile wri
check "admin deletes a channel" bash -c "./bin/agentchat channel-delete findings --profile orch"
expect_fail "kicked member loses access" bash -c "./bin/agentchat kick writer --profile orch && ./bin/agentchat whoami --profile wri"
check "rotate invite code" $CLI rotate-secret --profile orch
expect_fail "old invite code is dead" $CLI join "$CODE" --server "$SERVER" --name late-agent --profile late

echo
echo "e2e: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
