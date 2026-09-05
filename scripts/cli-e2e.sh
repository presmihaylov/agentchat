#!/usr/bin/env bash
# End-to-end for cli.sh: drive a real conversation with the CLI itself.
# Every command an agent needs is exercised here — send, thread reply, read,
# attachments both ways, mentions, reactions, membership.
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

# only a logged-in human creates a room: register a throwaway user, create with the session
reg=$(curl -fsS -X POST "$SERVER/api/v1/auth/password/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"cli-$(date +%s)-$RANDOM\",\"password\":\"cli-throwaway-pw\"}")
session=$(printf '%s' "$reg" | jq_ 'd["token"]')
created=$(curl -fsS -X POST "$SERVER/api/v1/rooms" -H "Authorization: Bearer $session" -H 'Content-Type: application/json' -d "{\"name\":\"cli check\",\"slug\":\"cli-check-$(date +%s)-$RANDOM\"}")
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

# 7e. a top-level send warns on stderr and names the roots it could have continued
"${A[@]}" send general 'another root' >"$WORK/out" 2>"$WORK/err" || fail "send failed"
grep -q 'caution, top-level post to #general' "$WORK/err" || fail "send did not caution: $(cat "$WORK/err")"
grep -q "$root" "$WORK/err" || fail "the caution did not list the earlier root $root"
grep -q -- '--new-topic' "$WORK/err" || fail "the caution did not name --new-topic"
grep -q '^posted ' "$WORK/out" || fail "the caution blocked the post"
"${A[@]}" send general 'meant as a root' --new-topic >/dev/null 2>"$WORK/err"
if grep -q 'caution' "$WORK/err"; then fail "--new-topic did not silence the caution"; fi
ok "send cautions about a top-level post, --new-topic silences it"

# 7g. a #name that is no channel warns but still posts; real, backticked and
#     numeric ones stay quiet
"${A[@]}" send general 'see #no-such-room for details' 2>"$WORK/err" >"$WORK/out" \
  || fail "an unknown #channel must still post"
grep -q 'posted' "$WORK/out" || fail "unknown #channel did not post: $(cat "$WORK/out")"
grep -q 'no channel named: no-such-room' "$WORK/err" || fail "no unknown-channel warning: $(cat "$WORK/err")"
"${A[@]}" send general 'see #general, `#no-such-room`, PR #10020' 2>"$WORK/err" >/dev/null \
  || fail "known #channel post failed"
if grep -q 'no channel named' "$WORK/err"; then fail "false channel warning: $(cat "$WORK/err")"; fi
ok "unknown #channel warns, known/backticked/numeric stay quiet"

# 7f. every read surface says root or reply, and names the root to reply under
"${A[@]}" read general | grep -F "[$root]" | grep -q 'root, 2 replies' || fail "read did not tag the root: $("${A[@]}" read general | grep -F "[$root]")"
"${A[@]}" thread "$root" | grep -F "[$r1]" | grep -q "reply in thread $root" || fail "thread did not tag the reply"
"${A[@]}" msg "$root" | grep -q 'root, 2 replies' || fail "msg did not tag the root"
[ "$("${A[@]}" msg "$r1" --json | jq_ 'd["reply_to"]')" = "$root" ] || fail "reply_to missing on a reply"
[ "$("${A[@]}" msg "$root" --json | jq_ 'd["reply_to"]')" = "$root" ] || fail "reply_to missing on a root"
ok "root/reply tags and reply_to on read, thread, msg"

# 7g. reply --latest lands in the newest thread you are part of, never at the root
"${B[@]}" mentions --limit 50 >/dev/null
"${A[@]}" reply "$root" 'one more for @bob' >/dev/null
lt=$("${B[@]}" reply --latest general 'found you without the id')
lt=${lt#posted }
[ "$("${B[@]}" msg "$lt" --json | jq_ 'd["thread_root_id"]')" = "$root" ] || fail "reply --latest did not land in $root"
out=$("${B[@]}" mentions --limit 50)
grep -q "one more for @bob" <<<"$out" || fail "mentions missed the reply"
grep -q "mentions you, reply in thread $root" <<<"$out" || fail "mentions did not tag the thread: $out"
"${A[@]}" reply "$root" 'no tag this time' >/dev/null
out=$("${B[@]}" mentions --limit 50)
grep -q "thread you are in, reply in thread $root" <<<"$out" || fail "an untagged follow-up was not labelled as a thread hit: $out"
ok "reply --latest and mentions tag the thread"

# 7h. a member who joined after the roster cache was warm is not a false alarm
carol=$(join carol)
"${A[@]}" reply "$root" 'welcome @carol' >"$WORK/out" 2>"$WORK/err" || fail "mentioning a new member failed: $(cat "$WORK/err")"
if grep -q 'no member answers' "$WORK/err"; then fail "a stale roster cache cried wolf on a new member: $(cat "$WORK/err")"; fi
ok "a new member does not trip the stale-cache warning"

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

# 9b. reactions: add, see who, the same emoji twice stays one, remove
"${B[@]}" react "$root" '👀' >/dev/null
"${B[@]}" react "$root" '👀' >/dev/null
"${A[@]}" react "$root" ':tada:' >/dev/null
"${A[@]}" msg "$root" | grep -q '👀 bob' || fail "reaction tag not visible"
"${A[@]}" msg "$root" --json | python3 -c '
import sys,json; d=json.load(sys.stdin); r=d["reactions"]
assert [x["emoji"] for x in r]==["👀",":tada:"], r
assert r[0]["count"]==1 and r[0]["names"]==["bob"], r' || fail "reaction json wrong"
"${B[@]}" unreact "$root" '👀' >/dev/null
"${A[@]}" unreact "$root" ':tada:' >/dev/null
"${A[@]}" msg "$root" | grep -q '👀' && fail "reaction survived unreact"
ok "reactions"

# 9b2. reactions <id> ✅ swaps bob's 👀 for ✅ in one call and leaves alice's alone
"${B[@]}" react "$root" '👀' >/dev/null
"${A[@]}" react "$root" '👀' >/dev/null
"${B[@]}" reactions "$root" '✅' | grep -q 'are now: ✅' || fail "reactions output"
"${A[@]}" msg "$root" --json | python3 -c '
import sys,json; d=json.load(sys.stdin); r={x["emoji"]:x["names"] for x in d["reactions"]}
assert r=={"👀":["alice"],"✅":["bob"]}, r' || fail "reactions swap wrong"
"${B[@]}" reactions "$root" | grep -q 'cleared' || fail "reactions clear output"
"${A[@]}" reactions "$root" >/dev/null
"${A[@]}" msg "$root" --json | python3 -c '
import sys,json; d=json.load(sys.stdin); assert d["reactions"]==[], d["reactions"]' || fail "reactions clear wrong"
ok "reactions swap"

# 9c. leave a thread: bob's untagged replies stop naming alice, a mention rejoins
c0=$(curl -fsS "$SERVER/api/v1/events?after=0" -H "Authorization: Bearer $alice" | python3 -c 'import sys,json;print(json.load(sys.stdin)["cursor"])')
"${A[@]}" leave "$root" | grep -q "left thread $root" || fail "leave output"
"${B[@]}" reply "$root" "carrying on without alice" >/dev/null
"${B[@]}" reply "$root" "@alice one more thing" >/dev/null
curl -fsS "$SERVER/api/v1/events?after=$c0" -H "Authorization: Bearer $alice" | python3 -c '
import sys,json
evs=[e["payload"] for e in json.load(sys.stdin)["events"] if e["type"]=="message.created"]
assert any(m["kind"]=="system" and m["body"]=="left this thread" and m["author_name"]=="alice" and m["mentions"]==[] for m in evs), evs
p={m["body"]:m["thread_participants"] for m in evs if m["kind"]!="system"}
assert "alice" not in p["carrying on without alice"], p
assert "alice" in p["@alice one more thing"], p' || fail "leave did not drop alice from thread_participants"
# leaving a thread you were pulled back into by a mention: the timeline says so
"${A[@]}" leave "$root" >/dev/null
"${A[@]}" mentions | grep -q "carrying on without alice" && fail "ac mentions still lists a thread alice left"
"${A[@]}" rejoin "$root" | grep -q "rejoined thread $root" || fail "rejoin output"
"${A[@]}" thread "$root" > "$WORK/thread"
grep -q "left this thread" "$WORK/thread" || fail "no 'left this thread' entry in the thread"
grep -q "rejoined this thread" "$WORK/thread" || fail "no 'rejoined this thread' entry in the thread"
ok "leave + rejoin"

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

# 12. --body-file and stdin, on a fresh root so earlier reply counts stay put
bfroot=$("${A[@]}" send general "@bob body-file root" --new-topic); bfroot=${bfroot#posted }
printf '%s\n' 'report "one"' '`code` costs $5 and '"'"'more'"'"'' > "$WORK/report.md"
bf=$("${A[@]}" reply "$bfroot" --body-file "$WORK/report.md"); bf=${bf#posted }
[ "$("${A[@]}" msg "$bf" --json | jq_ 'd["body"]')" = "$(cat "$WORK/report.md")" ] || fail "--body-file body mangled"
sf=$(cat "$WORK/report.md" | "${A[@]}" reply "$bfroot" --body-file -); sf=${sf#posted }
[ "$("${A[@]}" msg "$sf" --json | jq_ 'd["body"]')" = "$(cat "$WORK/report.md")" ] || fail "stdin body mangled"
df=$(cat "$WORK/report.md" | "${A[@]}" reply "$bfroot" -); df=${df#posted }
[ "$("${A[@]}" msg "$df" --json | jq_ 'd["body"]')" = "$(cat "$WORK/report.md")" ] || fail "dash body mangled"
"${A[@]}" reply "$bfroot" --body-file "$WORK/missing.md" 2>/dev/null && fail "a missing --body-file must exit non-zero"
ok "--body-file and stdin bodies"

# 13. inbox drain and ack (task 25): bob goes offline, misses a mention, drains it, acks it.
# Earlier steps left bob unacked rows too, so the counts are relative.
unacked() { "${B[@]}" inbox --peek | sed -n 's/^\([0-9]*\) unacked.*/\1/p'; }
before=$(unacked)
curl -fsS -X POST "$SERVER/api/v1/me/offline" -H "Authorization: Bearer $bob" >/dev/null
"${A[@]}" send general "@bob inbox test" --new-topic >/dev/null
[ "$(unacked)" = "$((before + 1))" ] || fail "peek should show $((before + 1)) unacked, got $(unacked)"
iseq=$("${B[@]}" inbox --peek --json | jq_ '[e["seq"] for e in d["events"] if e["payload"]["body"] == "@bob inbox test"][0]')
[ -n "$iseq" ] || fail "inbox --json gave no seq"
[ "$(unacked)" = "$((before + 1))" ] || fail "peek must not mark anything"
"${B[@]}" inbox | grep -q "seq $iseq" || fail "inbox drain did not print seq $iseq"
"${B[@]}" ack "$iseq" | grep -q "acked $iseq" || fail "ack did not confirm"
[ "$(unacked)" = "$before" ] || fail "peek should show $before unacked after the ack, got $(unacked)"
ok "inbox drain and ack"

# 14. room create / room ttl (task 26): a session token makes a workspace with an
# expiry and, with SLUG set, sets or clears it; an agent token cannot create rooms
printf 'SERVER=%s\nTOKEN=%s\n' "$SERVER" "$session" > "$WORK/human.env"
H=("$CLI" --env "$WORK/human.env")
tslug="cli-ttl-$(date +%s)-$RANDOM"
"${H[@]}" room create "ttl room" --slug "$tslug" --ttl 3600 | grep -q "slug $tslug.*expires" || fail "room create --ttl did not report an expiry"
printf 'SLUG=%s\n' "$tslug" >> "$WORK/human.env"
"${H[@]}" room ttl 86400 | grep -q 'expires' || fail "room ttl did not set"
"${H[@]}" room ttl 30 2>/dev/null && fail "room ttl 30 must fail (under 60s)"
"${H[@]}" room ttl clear | grep -q 'expiry removed' || fail "room ttl clear did not clear"
"${A[@]}" room create "nope" 2>/dev/null && fail "an agent token must not create a room"
ok "room create and room ttl"

echo CLI_E2E_OK
