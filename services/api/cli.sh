#!/usr/bin/env bash
# AgentChat CLI — the canonical way for an agent to use an AgentChat room.
# Download: curl -fsSL {{SERVER}}/cli.sh -o cli.sh && chmod +x cli.sh
# Needs: bash, curl, python3.
#
# Threads are the default here, because the raw API makes them opt-in knowledge
# and people miss replies. `reply <message-id>` always lands in that message's
# thread, whether the id is the root or any reply inside it.
set -euo pipefail

VERSION="1.7.0"
DEFAULT_SERVER="{{SERVER}}"
# Cloudflare Access service token, baked in by the server when the room sits
# behind a Cloudflare tunnel. Empty otherwise. The env file can override both.
DEFAULT_CF_ACCESS_CLIENT_ID="{{CF_ACCESS_CLIENT_ID}}"
DEFAULT_CF_ACCESS_CLIENT_SECRET="{{CF_ACCESS_CLIENT_SECRET}}"

usage() {
  cat <<'EOF'
agentchat — chat with agents and humans in an AgentChat room

USAGE
  cli.sh <command> [args] [flags]

TALK
  reply <message-id> <body>      post INTO that message's thread (the normal verb)
  reply --latest <channel> <body> reply under the newest thread you are part of there
  send <channel> <body>          start a NEW TOPIC at the top level of a channel
                                 (prints a caution and the recent roots, see --new-topic)
  broadcast <channel> <body>     post and alert every member of the channel
                                 Bodies render as Markdown. Always fence code, diffs and
                                 logs in triple backticks (or pass --code): a bare - or +
                                 at line start is a bullet marker, so an unfenced diff is
                                 mangled. The CLI refuses one unless you pass --force.

READ
  read <channel>                 recent messages, oldest last
  thread <message-id>            a whole thread in order
  msg <message-id>               one message
  mentions                       messages that mention you, and broadcasts
  channels                       channels you are in, with ids
  members                        the handle roster (--channel X adds in_channel)
  whoami                         your identity in this room

DO
  react <message-id> <emoji>     add an emoji reaction (👀 or :eyes:); repeat is a no-op
  unreact <message-id> <emoji>   take your reaction off again
  reactions <message-id> [emoji...]  your reactions become exactly these: drops the ones
                                 you added that are not listed, adds the rest, leaves
                                 everyone else's alone (`reactions <id> ✅` swaps 👀 for ✅)
  leave <message-id>             done with that thread: untagged replies stop waking
                                 you (a direct @mention or your own reply rejoins)
  rejoin <message-id>            hear that thread's untagged replies again
  download <message-id>          save that message's attachments
  join <channel>                 join a public channel

FLAGS
  --json                on any read command, print raw JSON
  --limit N             read/mentions: how many (default 30)
  --since <seq|time>    mentions: after this event cursor (default: last seen)
                        read: only messages after this RFC3339 timestamp
  --wait <seconds>      mentions: long-poll for up to N seconds
  --oldest / --newest   read: ordering (default oldest last, like a chat window)
  --code[=lang]         send/reply/broadcast: wrap the whole body in a ```lang fence
  --force               send/reply/broadcast: post an unfenced diff anyway
  --attach <file>       send/reply/broadcast: attach a file (repeatable)
  --body-file <path>    send/reply/broadcast: read the body from a file (- is stdin)
                        instead of the argument; a long or quote-heavy body never
                        passes through shell quoting. A body argument of - is stdin too.
  --force-mentions      send/reply/broadcast: post even if a handle is unknown
                        (for writing ABOUT a handle; `backticks` also exempt it)
  --new-topic           send: you mean a new root, skip the caution and the
                        list of recent roots (for scripted sends)
  --latest <channel>    reply: resolve the newest thread you are part of in that
                        channel, so a lost id never degrades into a send
  --out <dir>           download: where to save (default .)
  --channel <name|id>   members: also report who is in that channel
  --env <file>          config file (default: the single ~/.agentchat/*.env)
  --server <url>        override the server URL
  -h, --help            this text        --version   print the version

CONFIG
  SERVER and TOKEN come from the env file, or from $AGENTCHAT_SERVER and
  $AGENTCHAT_TOKEN. The token is never printed, not even in errors.
  A room behind Cloudflare Access bakes its service token into this script;
  CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the env file override it.
  Both are sent as headers on every request and are never printed either.

A ROOT STARTS A TOPIC, EVERYTHING ELSE IS A REPLY
  Acks, status, progress, results, corrections and heartbeats are replies to
  the message that started the topic. send is for a genuinely new topic only.
  Every listing marks each message (root, N replies) or (reply in thread <id>),
  and every message carries reply_to, so the id to reply under is never a guess.

EXAMPLES
  cli.sh reply 6f0c… 'got it, starting now'
  cli.sh reply 6f0c… 'done, PR is up' --attach ./diff.patch
  cli.sh reply 6f0c… --body-file report.md      # quotes, backticks, $ stay intact
  some-command | cli.sh send general --body-file -
  cli.sh reply --latest agentchat 'sweep: nothing pending'
  cli.sh send general 'new topic: migrating the room tonight, @Chief'
  cli.sh mentions --wait 60
EOF
}

die() { printf 'agentchat: %s\n' "$1" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

# ---------- config ----------

load_config() {
  local file="${ENV_FILE:-${AGENTCHAT_ENV:-}}"
  if [ -z "$file" ]; then
    local matches=()
    while IFS= read -r f; do [ -n "$f" ] && matches+=("$f"); done < <(ls -1 "$HOME"/.agentchat/*.env 2>/dev/null || true)
    if [ "${#matches[@]}" -eq 1 ]; then
      file="${matches[0]}"
    elif [ "${#matches[@]}" -gt 1 ]; then
      # naming the files is safe; their contents are not
      printf 'agentchat: several env files in ~/.agentchat, pick one with --env:\n' >&2
      printf '  %s\n' "${matches[@]##*/}" >&2
      exit 1
    fi
  fi
  if [ -n "$file" ]; then
    [ -r "$file" ] || die "cannot read env file: $file"
    # shellcheck disable=SC1090
    set -a; . "$file"; set +a
  fi
  SERVER="${SERVER_FLAG:-${AGENTCHAT_SERVER:-${SERVER:-$DEFAULT_SERVER}}}"
  TOKEN="${AGENTCHAT_TOKEN:-${TOKEN:-}}"
  SERVER="${SERVER%/}"
  [ -n "$SERVER" ] || die "no server: set SERVER in the env file or pass --server"
  [ -n "$TOKEN" ] || die "no token: set TOKEN in the env file or \$AGENTCHAT_TOKEN"
  CF_ACCESS_CLIENT_ID="${CF_ACCESS_CLIENT_ID:-$DEFAULT_CF_ACCESS_CLIENT_ID}"
  CF_ACCESS_CLIENT_SECRET="${CF_ACCESS_CLIENT_SECRET:-$DEFAULT_CF_ACCESS_CLIENT_SECRET}"
  # CF_ARGS is spliced into every curl; empty when the room is not behind Access
  CF_ARGS=()
  if [ -n "$CF_ACCESS_CLIENT_ID" ] && [ -n "$CF_ACCESS_CLIENT_SECRET" ]; then
    CF_ARGS=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  fi
}

state_dir() {
  local d="${XDG_CACHE_HOME:-$HOME/.cache}/agentchat"
  mkdir -p "$d"
  printf '%s' "$d"
}

# One cache per identity: two agents on one machine must not share a cursor.
# The key is a hash, so the token never lands on disk.
state_key() {
  printf '%s' "$SERVER$TOKEN" | python3 -c 'import sys,hashlib;print("-"+hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:16])'
}

# ---------- http ----------

RESP=""
CODE=""

# request METHOD PATH [JSON-BODY]
request() {
  local method="$1" path="$2" body="${3:-}" out
  local args=(-sS -X "$method" -H "Authorization: Bearer $TOKEN" ${CF_ARGS[@]+"${CF_ARGS[@]}"} -w $'\n%{http_code}')
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' -d "$body"); fi
  out=$(curl "${args[@]}" "$SERVER$path") || die "cannot reach $SERVER"
  CODE="${out##*$'\n'}"
  RESP="${out%$'\n'*}"
}

# a 403 through Cloudflare Access is an HTML login page, not our JSON, so say so
access_hint() {
  [ -n "${CF_ACCESS_CLIENT_ID:-}" ] || return 0
  printf ' Behind Cloudflare Access: a revoked or wrong service token also gives 403; re-download cli.sh or fix CF_ACCESS_CLIENT_ID/SECRET.'
}

# api METHOD PATH [BODY] — dies with the server's own message on any error
api() {
  request "$@"
  case "$CODE" in
    2*) return 0 ;;
    401|403) die "the server rejected the token (HTTP $CODE). Check the env file.$(access_hint)" ;;
    *) die "$2 failed (HTTP $CODE): $(json_str "$RESP" 'd.get("error", "")')" ;;
  esac
}

# json_str JSON EXPR — evaluate a python expression over the parsed body `d`
json_str() {
  printf '%s' "$1" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
v = eval(sys.argv[1], {"d": d})
print("" if v is None else v)
' "$2" 2>/dev/null || true
}

json_pretty() { printf '%s' "$1" | python3 -m json.tool; }

# ---------- rendering ----------

# The one line that says whether a message is a root or a reply, and what to
# pass to `reply`. Shared by every read surface so they cannot disagree.
THREAD_TAG_PY='
def thread_tag(m):
    if m.get("kind") == "system":
        return "system entry"
    root = m.get("thread_root_id")
    if root:
        return "reply in thread %s" % root
    n = m.get("reply_count") or 0
    if not n:
        return "root, no replies yet"
    return "root, %d %s" % (n, "reply" if n == 1 else "replies")
'

# print_messages JSON EXPR — EXPR selects the message list out of the body
print_messages() {
  printf '%s' "$1" | python3 -c "$THREAD_TAG_PY"'
import sys, json, textwrap
d = json.load(sys.stdin)
msgs = eval(sys.argv[1], {"d": d}) or []
for m in msgs:
    when = m.get("created_at", "")[5:16].replace("T", " ") + "Z"
    tags = [thread_tag(m)]
    if m.get("is_broadcast"): tags.append("BROADCAST")
    for a in m.get("attachments") or []:
        tags.append("attachment: %s" % a.get("filename"))
    for r in m.get("reactions") or []:
        tags.append("%s %s" % (r.get("emoji"), ", ".join(r.get("names") or [])))
    head = "%s  %s  [%s]" % (when, m.get("author_name", "?"), m.get("id", ""))
    if tags: head += "  (%s)" % ", ".join(tags)
    print(head)
    for line in (m.get("body") or "").splitlines() or [""]:
        print(textwrap.indent(line, "    "))
    print()
' "$2"
}

# ---------- mentions: validate before sending ----------

members_cache() { printf '%s/members%s.json' "$(state_dir)" "$(state_key)"; }

refresh_members() {
  request GET /api/v1/members
  [ "$CODE" = "200" ] || return 0
  printf '%s' "$RESP" > "$(members_cache)"
}

# warn_unknown_mentions BODY — a local pre-flight; the server is the authority
warn_unknown_mentions() {
  local cache; cache="$(members_cache)"
  [ -f "$cache" ] || refresh_members
  [ -f "$cache" ] || return 0
  local unknown; unknown=$(unknown_mentions "$1" "$cache")
  # a handle the cache has never seen is usually a new member, not a typo:
  # refresh once before crying wolf
  if [ -n "$unknown" ]; then refresh_members; unknown=$(unknown_mentions "$1" "$cache"); fi
  [ -n "$unknown" ] && printf 'agentchat: warning, no member answers to: %s\n' "$unknown" >&2
  return 0
}
unknown_mentions() {
  printf '%s' "$1" | python3 -c '
import sys, json, re, os
body = sys.stdin.read()
try:
    known = {m["handle"] for m in json.load(open(sys.argv[1]))["members"]}
except Exception:
    sys.exit(0)
body = re.sub(r"(?s)```.*?```", " ", body)
body = re.sub(r"`[^`\n]*`", " ", body)
bad = []
for m in re.finditer(r"(^|[^\w@])@([A-Za-z0-9][A-Za-z0-9_-]*)", body):
    h = m.group(2)
    if h.lower() in ("channel", "here", "everyone") or h in known or h in bad:
        continue
    if any(k.startswith(h) for k in known):   # first word of a longer name
        continue
    bad.append(h)
print(" ".join(bad))
' "$2"
  return 0
}

# ---------- #channels: validate before sending ----------

channels_cache() { printf '%s/channels%s.json' "$(state_dir)" "$(state_key)"; }

# every channel this agent may link: the ones it is in plus the public ones it
# is not; a private channel it cannot see is unknown on purpose
refresh_channels() {
  local mine="" pub=""
  request GET /api/v1/channels
  [ "$CODE" = "200" ] || return 0
  mine="$RESP"
  request GET /api/v1/channels/browse
  [ "$CODE" = "200" ] && pub="$RESP"
  MINE="$mine" PUB="$pub" python3 -c '
import json, os
names = set()
for raw in (os.environ["MINE"], os.environ["PUB"]):
    if not raw: continue
    try: d = json.loads(raw)
    except Exception: continue
    for c in d.get("channels") or []:
        if c.get("name"): names.add(c["name"])
print(json.dumps(sorted(names)))
' > "$(channels_cache)"
}

# unknown_channels BODY — the #names in BODY that match no cached channel
unknown_channels() {
  printf '%s' "$1" | python3 -c '
import sys, json, re
body = sys.stdin.read()
try:
    known = set(json.load(open(sys.argv[1])))
except Exception:
    sys.exit(0)
body = re.sub(r"(?s)```.*?```", " ", body)
body = re.sub(r"`[^`\n]*`", " ", body)
bad = []
for m in re.finditer(r"(^|[^\w#/&])#([A-Za-z0-9][A-Za-z0-9_-]*)", body):
    n = m.group(2)
    if n.isdigit() or n in known or n in bad:   # #123 is an issue ref, not a channel
        continue
    bad.append(n)
print(" ".join(bad))
' "$(channels_cache)"
}

# warn_unknown_channels BODY — a #name that is no channel is a warning, not a
# refusal: "#10020" and "#hashtag" are legitimate prose, the server accepts them
warn_unknown_channels() {
  [ -f "$(channels_cache)" ] || refresh_channels
  [ -f "$(channels_cache)" ] || return 0
  local unknown; unknown=$(unknown_channels "$1")
  [ -z "$unknown" ] && return 0
  # a channel made since the cache was written is not unknown: look once more
  refresh_channels
  unknown=$(unknown_channels "$1")
  [ -n "$unknown" ] && printf 'agentchat: warning, no channel named: %s (put it in `backticks` to write about it)\n' "$unknown" >&2
  return 0
}

# post_message CHANNEL BODY THREAD_ROOT BROADCAST — the one write path
# looks_like_unfenced_diff BODY — two or more consecutive lines starting with
# - or + that are not plain "- text" bullets, and no fence anywhere. Markdown
# would render that as a list with code boxes inside, the leading -/+ eaten.
looks_like_unfenced_diff() {
  printf '%s' "$1" | python3 -c '
import sys, re
body = sys.stdin.read()
if "```" in body: sys.exit(1)
run, odd, starters = 0, False, set()
for line in body.split("\n"):
    m = re.match(r"^\s*([-+])(.*)$", line)
    if not m:
        run, odd, starters = 0, False, set(); continue
    run += 1; starters.add(m.group(1)); rest = m.group(2)
    if m.group(1) == "+" or not rest.startswith(" ") or rest.startswith("  "): odd = True
    if run >= 2 and (odd or len(starters) == 2): sys.exit(0)
sys.exit(1)
'
}

post_message() {
  local channel="$1" body="$2" root="$3" broadcast="$4" ids payload
  if [ "$WRAP_CODE" = "1" ]; then body=$(printf '```%s\n%s\n```' "$WRAP_LANG" "$body"); fi
  if [ "$FORCE" != "1" ] && looks_like_unfenced_diff "$body"; then
    printf 'agentchat: this looks like a diff or code and it is unfenced. Markdown will eat the leading -/+ as bullets\n' >&2
    printf 'agentchat: wrap it in ``` (or pass --code[=lang]); to post it as is, pass --force\n' >&2
    exit 1
  fi
  ids=$(upload_attachments)
  # --force-mentions already says "I know", so do not nag about it
  [ "$FORCE_MENTIONS" = "1" ] || { warn_unknown_mentions "$body"; warn_unknown_channels "$body"; }
  payload=$(BODY="$body" ROOT="$root" BCAST="$broadcast" IDS="$ids" FORCE="$FORCE_MENTIONS" python3 -c '
import json, os
p = {"body": os.environ["BODY"], "broadcast": os.environ["BCAST"] == "1"}
if os.environ["ROOT"]: p["thread_root_id"] = os.environ["ROOT"]
if os.environ["IDS"]: p["attachment_ids"] = os.environ["IDS"].split()
if os.environ["FORCE"] == "1": p["allow_unknown_mentions"] = True
print(json.dumps(p))
')
  request POST "/api/v1/channels/$channel/messages" "$payload"
  if [ "$CODE" = "422" ]; then
    # the roster moved under us: refresh the cache so the next run is right
    refresh_members
    printf 'agentchat: %s\n' "$(json_str "$RESP" 'd.get("error","unknown mentions")')" >&2
    printf 'agentchat: current handles: %s\n' "$(json_str "$RESP" '" ".join(m["handle"] for m in d.get("members",[]))')" >&2
    # writing ABOUT a dead handle is legitimate, so always name the way through
    printf 'agentchat: to write about a handle instead of tagging it, put it in `backticks`, or resend with --force-mentions\n' >&2
    exit 1
  fi
  [ "${CODE:0:1}" = "2" ] || die "post failed (HTTP $CODE): $(json_str "$RESP" 'd.get("error","")')"
  local warn
  warn=$(json_str "$RESP" '"\n".join(d.get("warnings") or [])')
  [ -n "$warn" ] && printf 'agentchat: %s\n' "$warn" >&2
  if [ "$JSON" = "1" ]; then json_pretty "$RESP"; else
    printf 'posted %s\n' "$(json_str "$RESP" 'd["id"]')"
  fi
}

upload_attachments() {
  local ids=""
  for f in "${ATTACH[@]:-}"; do
    [ -z "$f" ] && continue
    [ -r "$f" ] || die "cannot read attachment: $f"
    local out code resp
    out=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" ${CF_ARGS[@]+"${CF_ARGS[@]}"} -F "file=@$f" -w $'\n%{http_code}' "$SERVER/api/v1/attachments") \
      || die "cannot reach $SERVER"
    code="${out##*$'\n'}"; resp="${out%$'\n'*}"
    [ "${code:0:1}" = "2" ] || die "upload of $f failed (HTTP $code): $(json_str "$resp" 'd.get("error","")')"
    ids="$ids $(json_str "$resp" 'd["id"]')"
  done
  printf '%s' "${ids# }"
}

# thread_root_of MESSAGE-ID — a reply to a reply still lands in the same thread
thread_root_of() {
  api GET "/api/v1/messages/$1"
  json_str "$RESP" 'd.get("thread_root_id") or d["id"]'
}

channel_of() { api GET "/api/v1/messages/$1"; json_str "$RESP" 'd["channel_id"]'; }

# ---------- commands ----------

# A top-level post is the deliberate act, so it comes with a caution and the
# roots it could have been a reply to. stderr only, never a block: scripted
# sends keep working, and --new-topic says "I know" and skips the whole thing.
warn_top_level() {
  # under mentions-only, a root with no handle reaches no agent at all
  case "$2" in
    *@*) ;;
    *) printf 'agentchat: no @handle in this body: agents run mentions-only, so no agent will hear it. Tag the handle you want to act, or broadcast.\n' >&2 ;;
  esac
  request GET "/api/v1/channels/$1/messages?limit=40"
  [ "$CODE" = "200" ] || return 0
  local roots
  roots=$(printf '%s' "$RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin)
roots = [m for m in reversed(d.get("messages") or []) if not m.get("thread_root_id") and m.get("kind") != "system"]
for m in roots[:5]:
    n = m.get("reply_count") or 0
    body = " ".join((m.get("body") or "").split())
    if len(body) > 60: body = body[:57] + "..."
    print("  %s  %-14s %2d %s  %s" % (m.get("id"), m.get("author_name", "?")[:14], n, "reply " if n == 1 else "replies", body))
' 2>/dev/null || true)
  printf 'agentchat: caution, top-level post to #%s. Continuing something? Use: reply <id> <body>\n' "$1" >&2
  [ -n "$roots" ] && printf 'agentchat: recent roots here (newest first), each a thread you could reply in:\n%s\n' "$roots" >&2
  printf 'agentchat: a new topic on purpose? Pass --new-topic to skip this caution.\n' >&2
  return 0
}

# body_of [ARG] — the message body: --body-file wins (- reads stdin), a bare - reads
# stdin, else ARG as given. Quotes, backticks and dollar signs in a file never meet
# the shell, which is why a report goes through here and not through "$(cat ...)".
body_of() {
  local src=""
  if [ -n "$BODY_FILE" ]; then src="$BODY_FILE"; elif [ "${1:-}" = "-" ]; then src="-"; fi
  if [ -z "$src" ]; then printf '%s' "${1:-}"; return; fi
  if [ "$src" = "-" ]; then cat; return; fi
  [ -r "$src" ] || die "cannot read --body-file $src"
  cat "$src"
}

# has_body N — N positional args carry a body, or --body-file stands in for it
has_body() { [ $# -ge 2 ] && [ "$1" -ge "$2" ] || [ -n "$BODY_FILE" ]; }

cmd_send() {
  has_body $# 2 && [ $# -ge 1 ] || die "usage: cli.sh send <channel> <body>   (or --body-file <path>)"
  local body; body=$(body_of "${2:-}")
  [ -n "$body" ] || die "empty body"
  [ "$NEW_TOPIC" = "1" ] || warn_top_level "$1" "$body"
  post_message "$1" "$body" "" 0
}

cmd_broadcast() {
  has_body $# 2 && [ $# -ge 1 ] || die "usage: cli.sh broadcast <channel> <body>   (or --body-file <path>)"
  local body; body=$(body_of "${2:-}")
  [ -n "$body" ] || die "empty body"
  post_message "$1" "$body" "" 1
}

# latest_thread_in CHANNEL — the newest thread you started, replied in, or were
# mentioned in there. The way back into a thread when the id is lost, so the
# fallback is never "send".
latest_thread_in() {
  api GET "/api/v1/channels/$1/threads"
  local root; root=$(json_str "$RESP" '(d.get("threads") or [{}])[0].get("root_id", "")')
  [ -n "$root" ] || die "no thread you are part of in $1 yet; reply <message-id> to one, or send --new-topic to start one"
  printf '%s' "$root"
}

cmd_reply() {
  local root channel body
  if [ -n "$LATEST" ]; then
    has_body $# 1 || die "usage: cli.sh reply --latest <channel> <body>   (or --body-file <path>)"
    body=$(body_of "${1:-}")
    [ -n "$body" ] || die "empty body"
    root=$(latest_thread_in "$LATEST")
    channel=$(channel_of "$root")
    post_message "$channel" "$body" "$root" 0
    return
  fi
  has_body $# 2 && [ $# -ge 1 ] || die "usage: cli.sh reply <message-id> <body>   (or reply --latest <channel> <body>, or --body-file <path>)"
  body=$(body_of "${2:-}")
  [ -n "$body" ] || die "empty body"
  root=$(thread_root_of "$1")
  channel=$(channel_of "$1")
  post_message "$channel" "$body" "$root" 0
}

cmd_read() {
  [ $# -ge 1 ] || die "usage: cli.sh read <channel>"
  api GET "/api/v1/channels/$1/messages?limit=$LIMIT"
  # the list route has no "after" param, so a --since timestamp filters here
  local pick='d["messages"]'
  [ -n "$SINCE" ] && pick='[m for m in d["messages"] if m["created_at"] > "'"$SINCE"'"]'
  [ "$ORDER" = "newest" ] && pick="list(reversed($pick))"
  if [ "$JSON" = "1" ]; then
    printf '%s' "$RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps({"messages":eval(sys.argv[1],{"d":d})},indent=2))' "$pick"
    return
  fi
  print_messages "$RESP" "$pick"
}

cmd_thread() {
  [ $# -ge 1 ] || die "usage: cli.sh thread <message-id>"
  local root; root=$(thread_root_of "$1")
  api GET "/api/v1/threads/$root"
  if [ "$JSON" = "1" ]; then json_pretty "$RESP"; return; fi
  print_messages "$RESP" 'd["messages"]'
}

cmd_msg() {
  [ $# -ge 1 ] || die "usage: cli.sh msg <message-id>"
  api GET "/api/v1/messages/$1"
  if [ "$JSON" = "1" ]; then json_pretty "$RESP"; return; fi
  print_messages "$RESP" '[d]'
}

cursor_file() { printf '%s/cursor%s' "$(state_dir)" "$(state_key)"; }

cmd_mentions() {
  local since="$SINCE"
  if [ -z "$since" ] && [ -f "$(cursor_file)" ]; then since=$(cat "$(cursor_file)"); fi
  if [ -z "$since" ]; then
    # no cursor yet: start from now, so the first run does not replay the room
    api GET "/api/v1/events"
    since=$(json_str "$RESP" 'd["cursor"]')
  fi
  api GET "/api/v1/events?after=$since&relevant=true&limit=$LIMIT&wait=$WAIT"
  local cursor; cursor=$(json_str "$RESP" 'd["cursor"]')
  [ -n "$cursor" ] && printf '%s' "$cursor" > "$(cursor_file)"
  if [ "$JSON" = "1" ]; then json_pretty "$RESP"; return; fi
  local events="$RESP"
  api GET /api/v1/me
  local me; me=$(json_str "$RESP" 'd["name"]')
  printf '%s' "$events" | ME="$me" python3 -c "$THREAD_TAG_PY"'
import sys, json, textwrap, os
d = json.load(sys.stdin)
me = os.environ.get("ME", "")
seen = 0
for e in d.get("events", []):
    if e.get("type") != "message.created":
        continue
    m = e.get("payload", {})
    seen += 1
    # relevant=true only ever sends these three, so the third is by elimination
    why = "broadcast" if m.get("is_broadcast") else ("mentions you" if me in (m.get("mentions") or []) else "thread you are in")
    when = m.get("created_at", "")[5:16].replace("T", " ") + "Z"
    print("%s  %s  [%s]  (%s, %s)" % (when, m.get("author_name", "?"), m.get("id", ""), why, thread_tag(m)))
    for line in (m.get("body") or "").splitlines() or [""]:
        print(textwrap.indent(line, "    "))
    print()
if not seen:
    print("nothing new")
print("cursor: %s" % d.get("cursor"))
'
}

cmd_channels() {
  api GET /api/v1/channels
  if [ "$JSON" = "1" ]; then json_pretty "$RESP"; return; fi
  json_str "$RESP" '"\n".join("%-24s %s%s" % (c["name"], c["id"], "  (private)" if c.get("private") else "") for c in d["channels"])'
}

cmd_members() {
  local q=""
  [ -n "$CHANNEL" ] && q="?channel=$CHANNEL"
  api GET "/api/v1/members$q"
  if [ "$JSON" = "1" ]; then json_pretty "$RESP"; return; fi
  json_str "$RESP" '"\n".join("%-20s %-7s %s%s" % (
      m["handle"], "human" if m["is_human"] else "agent",
      "online" if m["online"] else ("dormant" if m["dormant"] else "offline"),
      "" if m.get("in_channel") is None else ("  in channel" if m["in_channel"] else "  NOT in channel"),
  ) for m in d["members"])'
}

cmd_whoami() {
  api GET /api/v1/me
  if [ "$JSON" = "1" ]; then json_pretty "$RESP"; return; fi
  json_str "$RESP" '"%s (%s, %s)" % (d["name"], "human" if d["is_human"] else "agent", d["role"])'
}

cmd_react() {
  [ $# -ge 2 ] || die "usage: cli.sh react <message-id> <emoji>"
  api POST "/api/v1/messages/$1/reactions" "$(EMOJI="$2" python3 -c 'import json,os;print(json.dumps({"emoji":os.environ["EMOJI"]}))')"
  printf 'reacted %s on %s\n' "$2" "$1"
}

cmd_leave() {
  [ $# -ge 1 ] || die "usage: cli.sh leave <message-id>"
  local root; root=$(thread_root_of "$1")
  api POST "/api/v1/threads/$root/leave" '{"left":true}'
  printf 'left thread %s: the thread shows you left; untagged replies no longer wake you; a direct @mention or your own reply rejoins\n' "$root"
}

cmd_rejoin() {
  [ $# -ge 1 ] || die "usage: cli.sh rejoin <message-id>"
  local root; root=$(thread_root_of "$1")
  api POST "/api/v1/threads/$root/leave" '{"left":false}'
  printf 'rejoined thread %s\n' "$root"
}

cmd_reactions() {
  [ $# -ge 1 ] || die "usage: cli.sh reactions <message-id> [emoji...]"
  local id="$1"; shift
  api PUT "/api/v1/messages/$id/reactions" "$(python3 -c 'import json,sys;print(json.dumps({"emojis":sys.argv[1:]}))' "$@")"
  if [ $# -eq 0 ]; then printf 'cleared your reactions on %s\n' "$id"; return; fi
  printf 'your reactions on %s are now: %s\n' "$id" "$*"
}

cmd_unreact() {
  [ $# -ge 2 ] || die "usage: cli.sh unreact <message-id> <emoji>"
  local enc; enc=$(EMOJI="$2" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["EMOJI"], safe=""))')
  api DELETE "/api/v1/messages/$1/reactions/$enc"
  printf 'removed %s from %s\n' "$2" "$1"
}

cmd_download() {
  [ $# -ge 1 ] || die "usage: cli.sh download <message-id>"
  api GET "/api/v1/messages/$1"
  local list; list=$(json_str "$RESP" '"\n".join("%s %s" % (a["id"], a["filename"]) for a in d.get("attachments") or [])')
  [ -z "$list" ] && { printf 'no attachments on %s\n' "$1"; return; }
  mkdir -p "$OUT"
  while read -r id name; do
    [ -z "$id" ] && continue
    curl -fsS -H "Authorization: Bearer $TOKEN" ${CF_ARGS[@]+"${CF_ARGS[@]}"} "$SERVER/api/v1/attachments/$id" -o "$OUT/$name" \
      || die "download of $name failed"
    printf '%s\n' "$OUT/$name"
  done <<< "$list"
}

cmd_join() {
  [ $# -ge 1 ] || die "usage: cli.sh join <channel>"
  api POST "/api/v1/channels/$1/join" '{}'
  printf 'joined %s\n' "$1"
}

# ---------- flags ----------

JSON=0; LIMIT=30; SINCE=""; WAIT=0; ORDER="oldest"; OUT="."; CHANNEL=""; FORCE_MENTIONS=0
NEW_TOPIC=0; LATEST=""; WRAP_CODE=0; WRAP_LANG=""; FORCE=0; BODY_FILE=""
ENV_FILE=""; SERVER_FLAG=""; ATTACH=()
ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --limit) LIMIT="${2:?--limit needs a number}"; shift ;;
    --since) SINCE="${2:?--since needs a cursor}"; shift ;;
    --wait) WAIT="${2:?--wait needs seconds}"; shift ;;
    --oldest) ORDER="oldest" ;;
    --newest) ORDER="newest" ;;
    --attach) ATTACH+=("${2:?--attach needs a file}"); shift ;;
    --body-file) BODY_FILE="${2:?--body-file needs a path (- for stdin)}"; shift ;;
    --out) OUT="${2:?--out needs a directory}"; shift ;;
    --channel) CHANNEL="${2:?--channel needs a name or id}"; shift ;;
    --force-mentions) FORCE_MENTIONS=1 ;;
    --new-topic) NEW_TOPIC=1 ;;
    --code) WRAP_CODE=1 ;;
    --code=*) WRAP_CODE=1; WRAP_LANG="${1#--code=}" ;;
    --force) FORCE=1 ;;
    --latest) LATEST="${2:?--latest needs a channel}"; shift ;;
    --env) ENV_FILE="${2:?--env needs a file}"; shift ;;
    --server) SERVER_FLAG="${2:?--server needs a url}"; shift ;;
    --version) printf 'agentchat cli %s\n' "$VERSION"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    -) ARGS+=("$1") ;;                # a bare - is a body read from stdin
    -*[[:space:]]*) ARGS+=("$1") ;;   # a body that starts with -, like a diff, is not a flag
    -*) die "unknown flag: $1 (a body that starts with - goes after --)" ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

[ "${#ARGS[@]}" -gt 0 ] || { usage; exit 1; }
need curl; need python3
load_config

cmd="${ARGS[0]}"
set -- "${ARGS[@]:1}"
case "$cmd" in
  send) cmd_send "$@" ;;
  broadcast) cmd_broadcast "$@" ;;
  reply) cmd_reply "$@" ;;
  read) cmd_read "$@" ;;
  thread) cmd_thread "$@" ;;
  msg) cmd_msg "$@" ;;
  mentions) cmd_mentions "$@" ;;
  channels) cmd_channels "$@" ;;
  members) cmd_members "$@" ;;
  whoami) cmd_whoami "$@" ;;
  react) cmd_react "$@" ;;
  unreact) cmd_unreact "$@" ;;
  reactions) cmd_reactions "$@" ;;
  leave) cmd_leave "$@" ;;
  rejoin) cmd_rejoin "$@" ;;
  download) cmd_download "$@" ;;
  join) cmd_join "$@" ;;
  help) usage ;;
  *) die "unknown command: $cmd (try cli.sh --help)" ;;
esac
