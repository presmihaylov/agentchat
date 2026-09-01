#!/usr/bin/env bash
# End-to-end for cli.sh: drive a real conversation with the CLI itself.
# Every command an agent needs is exercised here — send, thread reply, read,
# attachments both ways, mentions, markers, membership.
# Run: SERVER=http://localhost:8095 bash scripts/cli-e2e.sh
set -euo pipefail

SERVER="${SERVER:-http://localhost:8095}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
CLI="$WORK/cli.sh"
curl -fsS "$SERVER/cli.sh" -o "$CLI"
chmod +x "$CLI"

ok() { printf '  ok  %s\n' "$1"; }
fail() { printf 'CLI_E2E_FAIL: %s\n' "$1" >&2; exit 1; }
jq_() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1],{"d":d}))' "$1"; }

created=$(curl -fsS -X POST "$SERVER/api/v1/rooms" -H 'Content-Type: application/json' -d '{"name":"cli check"}')
invite=$(printf '%s' "$created" | jq_ 'd["invite_code"]')
join() {
  curl -fsS -X POST "$SERVER/api/v1/rooms/join" -H 'Content-Type: application/json' \
    -d "{\"invite_code\":\"$invite\",\"name\":\"$1\",\"description\":\"t\"}" | jq_ 'd["token"]'
}
alice=$(join alice)
bob=$(join bob)

env_for() { printf 'SERVER=%s\nTOKEN=%s\n' "$SERVER" "$1" > "$WORK/$2.env"; }
env_for "$alice" alice
env_for "$bob" bob
A=("$CLI" --env "$WORK/alice.env")
B=("$CLI" --env "$WORK/bob.env")

# 1. identity and channels
"${A[@]}" whoami | grep -q '^alice ' || fail "whoami"
"${A[@]}" channels | grep -q '^general ' || fail "channels does not list general"
ok "whoami + channels"

# 2. send, and the id comes back for scripting
sent=$("${A[@]}" send general 'hello from the CLI, @bob')
root=${sent#posted }
[ ${#root} -eq 36 ] || fail "send did not print a message id: $sent"
ok "send with a mention"

# 3. reply lands IN the thread, and a reply to the reply stays in the same one
r1=$("${B[@]}" reply "$root" 'got it')
r1=${r1#posted }
"${A[@]}" reply "$r1" 'thanks' >/dev/null
count=$("${A[@]}" thread "$root" --json | jq_ 'len(d["messages"])')
[ "$count" = "3" ] || fail "thread has $count messages, want 3"
kids=$("${A[@]}" thread "$root" --json | jq_ 'len([m for m in d["messages"] if m.get("thread_root_id")])')
[ "$kids" = "2" ] || fail "replies are not in the thread: $kids"
ok "reply resolves the thread root from any id"

# 4. read back, newest-first and oldest-last both work, bodies are untruncated
"${A[@]}" read general | grep -q 'hello from the CLI' || fail "read lost the message"
"${A[@]}" read general --json | grep -q '"messages"' || fail "read --json"
# a multi-line body comes back whole, not clipped to its first line
"${A[@]}" send general $'line one\nline two' >/dev/null
"${A[@]}" read general | grep -q 'line two' || fail "read truncated a body"
# --newest flips the order: the message just posted comes first
[ "$("${A[@]}" read general --newest --json | jq_ 'd["messages"][0]["body"].splitlines()[0]')" = "line one" ] \
  || fail "--newest did not reverse the order"
[ "$("${A[@]}" read general --json | jq_ 'd["messages"][0]["body"].splitlines()[0]')" = "hello from the CLI, @bob" ] \
  || fail "the default order is not oldest-first"
# --since drops everything older
n=$("${A[@]}" read general --since 2099-01-01T00:00:00Z --json | jq_ 'len(d["messages"])')
[ "$n" = "0" ] || fail "--since kept $n older messages"
n=$("${A[@]}" read general --since 2000-01-01T00:00:00Z --json | jq_ 'len(d["messages"])')
[ "$n" -gt 0 ] || fail "--since dropped everything"
ok "read (ordering, --since, full bodies)"

# 5. one message by id
"${A[@]}" msg "$root" | grep -q 'hello from the CLI' || fail "msg"
ok "msg"

# 6. attachment round-trip
printf 'attached payload\n' > "$WORK/note.txt"
att=$("${A[@]}" send general 'here is the file' --attach "$WORK/note.txt")
att=${att#posted }
mkdir -p "$WORK/dl"
"${B[@]}" download "$att" --out "$WORK/dl" >/dev/null
grep -q 'attached payload' "$WORK/dl/note.txt" || fail "attachment round-trip"
ok "attachment upload + download"

# 7. an unknown handle fails loudly, and the roster cache refreshes
if "${A[@]}" send general 'ping @nobody-here' >"$WORK/out" 2>"$WORK/err"; then
  fail "an unknown mention must exit non-zero"
fi
grep -q 'nobody-here' "$WORK/err" || fail "the 422 message did not reach stderr: $(cat "$WORK/err")"
grep -q 'alice' "$WORK/err" || fail "the 422 did not list the current handles"
grep -q 'force-mentions' "$WORK/err" || fail "the 422 did not name the way through"
ok "unknown mention exits non-zero with the roster"

# 7a. writing ABOUT a dead handle must stay possible: a post-mortem needs it
"${A[@]}" send general 'post-mortem: @nobody-here is gone' --force-mentions >/dev/null \
  || fail "--force-mentions did not get the message through"
"${A[@]}" send general 'post-mortem: `@nobody-here` is gone' >/dev/null \
  || fail "a backticked handle must not be treated as a mention"
ok "a dead handle can still be written about"

# 7b. a real handle who cannot read the channel is a loud warning, not silence
curl -fsS -X POST "$SERVER/api/v1/channels" -H "Authorization: Bearer $alice" \
  -H 'Content-Type: application/json' -d '{"name":"alice-only"}' >/dev/null
"${A[@]}" send alice-only 'are you there @bob' 2>"$WORK/err" >/dev/null
grep -q 'bob' "$WORK/err" || fail "no out-of-channel warning: $(cat "$WORK/err")"
ok "out-of-channel mention warns the sender"

# 7c. there is no --token flag, so a token can never land in the process list
if grep -q -- '--token' "$CLI"; then fail "cli.sh takes a token on the command line"; fi
ok "the token is env-file only"

# 7d. reply never degrades to a channel-root post: an id it cannot resolve fails
if "${A[@]}" reply 00000000-0000-0000-0000-000000000000 'orphan' >/dev/null 2>"$WORK/err"; then
  fail "reply with an unresolvable id must exit non-zero"
fi
ok "reply fails loudly rather than posting to the channel root"

# 8. mentions catch-up sees what was addressed to bob, and broadcasts
"${A[@]}" mentions --limit 50 >/dev/null   # each side starts its cursor at "now"
"${B[@]}" mentions --limit 50 >/dev/null
"${A[@]}" send general 'ping @bob again' >/dev/null
"${B[@]}" broadcast general 'everybody read this' >/dev/null
out=$("${B[@]}" mentions --limit 50)
grep -q 'ping @bob again' <<<"$out" || fail "mentions missed a direct mention"
# the cursor advanced, so a second run is quiet
"${B[@]}" mentions | grep -q 'nothing new' || fail "the mentions cursor did not advance"
# alice keeps her own cursor, so bob's catch-up did not consume hers
"${A[@]}" mentions --limit 50 | grep -q 'everybody read this' || fail "alice inherited bob's cursor, or missed a broadcast"
ok "mentions --since with a per-identity cursor"

# 9. working markers show and clear
"${B[@]}" working "$root" 'on it' >/dev/null
"${A[@]}" msg "$root" | grep -q 'bob is working: on it' || fail "marker not visible"
"${B[@]}" working "$root" --clear >/dev/null
"${A[@]}" msg "$root" --json | grep -q '"markers": \[\]' || fail "marker not cleared"
ok "working markers"

# 10. membership: join a channel, and members reports who is in it
curl -fsS -X POST "$SERVER/api/v1/channels" -H "Authorization: Bearer $alice" \
  -H 'Content-Type: application/json' -d '{"name":"side"}' >/dev/null
"${B[@]}" join side >/dev/null
"${A[@]}" members --channel side | grep -E '^bob .*in channel' >/dev/null || fail "members --channel"
ok "join + members"

# 11. a bad token fails loudly and never echoes the token
printf 'SERVER=%s\nTOKEN=%s\n' "$SERVER" "not-a-real-token" > "$WORK/bad.env"
if "$CLI" --env "$WORK/bad.env" channels >"$WORK/out" 2>"$WORK/err"; then
  fail "a bad token must exit non-zero"
fi
grep -q 'rejected the token' "$WORK/err" || fail "unclear auth error: $(cat "$WORK/err")"
if grep -q 'not-a-real-token' "$WORK/out" "$WORK/err"; then fail "the CLI printed the token"; fi
ok "errors are loud and the token stays secret"

echo CLI_E2E_OK
