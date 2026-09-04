package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/presmihaylov/agentchat/models"
)

// sessionRoom registers a user and creates a room with the session; the
// returned client already names the room with X-Workspace-Slug.
func sessionRoom(t *testing.T, base, name string) (creator *testClient, user, room map[string]any) {
	t.Helper()
	creator, reg := register(t, base, uniqUser(), "correct horse")
	out := creator.must("POST", "/api/v1/rooms", map[string]any{"name": name}, 201)
	room = out["room"].(map[string]any)
	room["invite_code"] = out["invite_code"]
	creator.slug = room["slug"].(string)
	return creator, reg["user"].(map[string]any), room
}

// registerAs is register with a chosen display name, so a test can control
// the participant name the human gets on /enter.
func registerAs(t *testing.T, base, displayName string) (*testClient, map[string]any) {
	t.Helper()
	c := &testClient{t: t, base: base}
	out := c.must("POST", "/api/v1/auth/password/register", map[string]any{
		"username": uniqUser(), "password": "correct horse", "display_name": displayName,
	}, 201)
	c.token = out["token"].(string)
	return c, out
}

func TestRoomCreateRequiresSession(t *testing.T) {
	srv, _ := newTestServer(t)
	anon := &testClient{t: t, base: srv.URL}
	if st, out := anon.do("POST", "/api/v1/rooms", map[string]any{"name": "nope"}); st != 401 || out["code"] != "session_required" {
		t.Fatalf("anonymous create: %d %v", st, out)
	}
	_, alice, _ := setupRoom(t, srv.URL)
	if st, out := alice.do("POST", "/api/v1/rooms", map[string]any{"name": "nope"}); st != 401 || out["code"] != "session_required" {
		t.Fatalf("act_ create: %d %v", st, out)
	}

	creator, user, room := sessionRoom(t, srv.URL, "mine")
	if room["created_by_user_id"] != user["id"] {
		t.Fatalf("created_by_user_id: %v", room)
	}
	me := creator.must("GET", "/api/v1/me", nil, 200)
	if me["role"] != "admin" || me["is_human"] != true || me["user_id"] != user["id"] || me["username"] != user["username"] {
		t.Fatalf("creator participant: %v", me)
	}
	if me["name"] != "Test Person" {
		t.Fatalf("creator name should be the display name: %v", me["name"])
	}
	// #general membership and the roster carry the linked human
	overview := creator.must("GET", "/api/v1/room", nil, 200)
	parts := overview["participants"].([]any)
	if len(parts) != 1 || parts[0].(map[string]any)["user_id"] != user["id"] {
		t.Fatalf("participants: %v", parts)
	}
	if overview["invite_code"] != room["invite_code"] {
		t.Fatalf("admin creator must see the invite code: %v", overview["invite_code"])
	}
	chans := creator.must("GET", "/api/v1/channels", nil, 200)["channels"].([]any)
	if len(chans) != 1 || chans[0].(map[string]any)["name"] != "general" {
		t.Fatalf("channels: %v", chans)
	}
	// the join event names the user; the switcher hint points at the new room
	var payload map[string]any
	if err := testDB(t).QueryRow(context.Background(),
		`SELECT payload FROM events WHERE room_id = $1 AND type = 'participant.joined'`, room["id"]).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["user_id"] != user["id"] {
		t.Fatalf("participant.joined payload: %v", payload)
	}
	acct := creator.must("GET", "/api/v1/user", nil, 200)["user"].(map[string]any)
	if acct["last_active_workspace_id"] != room["id"] {
		t.Fatalf("last_active_workspace_id: %v", acct)
	}
}

func TestRoomCreateInvalidDisplayNameUsesUsername(t *testing.T) {
	srv, _ := newTestServer(t)
	name := uniqUser()
	c := &testClient{t: t, base: srv.URL}
	out := c.must("POST", "/api/v1/auth/password/register", map[string]any{
		"username": name, "password": "correct horse",
		"display_name": "a display name that is far too long to be a participant name 🎉",
	}, 201)
	c.token = out["token"].(string)
	room := c.must("POST", "/api/v1/rooms", map[string]any{"name": "long"}, 201)["room"].(map[string]any)
	c.slug = room["slug"].(string)
	if me := c.must("GET", "/api/v1/me", nil, 200); me["name"] != name {
		t.Fatalf("want participant name %q, got %v", name, me["name"])
	}
}

func TestRoomQuota(t *testing.T) {
	srv, _ := newTestServer(t)
	c, _ := register(t, srv.URL, uniqUser(), "correct horse")
	for i := 0; i < models.RoomQuota; i++ {
		c.must("POST", "/api/v1/rooms", map[string]any{"name": "room"}, 201)
	}
	if st, out := c.do("POST", "/api/v1/rooms", map[string]any{"name": "one too many"}); st != 409 || out["code"] != "workspace_quota" {
		t.Fatalf("sixth create: %d %v", st, out)
	}
	// the cap is per creator, not global
	other, _ := register(t, srv.URL, uniqUser(), "correct horse")
	other.must("POST", "/api/v1/rooms", map[string]any{"name": "room"}, 201)
}

// participantsColumns is the participants table before task 03 plus user_id.
var participantsColumns = []string{
	"archive_after_secs", "avatar", "avatar_attachment_id", "created_at", "description", "id", "is_human",
	"last_seen_at", "name", "notify_enabled", "notify_sound", "owner_id", "presence_online", "revoked",
	"role", "room_id", "token_hash", "user_id",
}

func TestAgentJoinRowUnchanged(t *testing.T) {
	srv, _ := newTestServer(t)
	ctx := context.Background()
	db := testDB(t)
	out := createRoom(t, srv.URL, "agents")
	code := out["invite_code"].(string)
	roomID := out["room"].(map[string]any)["id"].(string)

	c := &testClient{t: t, base: srv.URL}
	joined := c.must("POST", "/api/v1/rooms/join", map[string]any{
		"invite_code": code, "name": "worker", "description": "does things",
	}, 201)
	token := joined["token"].(string)
	pid := joined["participant"].(map[string]any)["id"].(string)

	rows, err := db.Query(ctx, `SELECT column_name FROM information_schema.columns WHERE table_name = 'participants'`)
	if err != nil {
		t.Fatal(err)
	}
	cols := []string{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		cols = append(cols, c)
	}
	rows.Close()
	sort.Strings(cols)
	if strings.Join(cols, ",") != strings.Join(participantsColumns, ",") {
		t.Fatalf("participants columns changed:\n got %v\nwant %v", cols, participantsColumns)
	}

	var row map[string]any
	if err := db.QueryRow(ctx,
		`SELECT to_jsonb(p) - 'id' - 'room_id' - 'created_at' - 'last_seen_at' || jsonb_build_object('token_hex', encode(token_hash, 'hex'))
		 FROM participants p WHERE id = $1`, pid).Scan(&row); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(token))
	want := map[string]any{
		"archive_after_secs": float64(3600), "avatar": "🤖", "avatar_attachment_id": nil, "description": "does things",
		"is_human": false, "name": "worker", "notify_enabled": true, "notify_sound": true, "owner_id": nil,
		"presence_online": true, "revoked": false, "role": "admin", "user_id": nil,
		"token_hash": row["token_hash"], "token_hex": hex.EncodeToString(sum[:]),
	}
	got, _ := json.Marshal(row)
	exp, _ := json.Marshal(want)
	if string(got) != string(exp) {
		t.Fatalf("agent row drifted:\n got %s\nwant %s", got, exp)
	}

	// the join event carries exactly the keys it always did
	var payload map[string]any
	if err := db.QueryRow(ctx,
		`SELECT payload FROM events WHERE room_id = $1 AND type = 'participant.joined' AND payload->>'participant_id' = $2`,
		roomID, pid).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "description,is_human,name,owner_id,participant_id,role" {
		t.Fatalf("participant.joined keys for an agent: %v", keys)
	}
}

func TestJoinCannotReclaimLinkedHuman(t *testing.T) {
	srv, store := newTestServer(t)
	creator, _, room := sessionRoom(t, srv.URL, "linked")
	me := creator.must("GET", "/api/v1/me", nil, 200)
	if err := store.BackdateSeen(context.Background(), me["id"].(string)); err != nil {
		t.Fatal(err)
	}
	c := &testClient{t: t, base: srv.URL}
	st, out := c.do("POST", "/api/v1/rooms/join", map[string]any{
		"invite_code": room["invite_code"], "name": me["name"], "is_human": true,
	})
	if st != 409 || !strings.Contains(out["error"].(string), "logged-in") {
		t.Fatalf("reclaim of a linked human: %d %v", st, out)
	}
	// the row is untouched and still the user's
	after := creator.must("GET", "/api/v1/me", nil, 200)
	if after["id"] != me["id"] || after["role"] != "admin" || after["user_id"] != me["user_id"] {
		t.Fatalf("linked row changed: %v", after)
	}
}

func TestSessionAuthResolvesParticipant(t *testing.T) {
	srv, _ := newTestServer(t)
	creator, user, room := sessionRoom(t, srv.URL, "first")
	me := creator.must("GET", "/api/v1/me", nil, 200)
	if me["user_id"] != user["id"] || me["username"] != user["username"] || me["room_id"] != room["id"] {
		t.Fatalf("me: %v", me)
	}
	// the session touches presence like an agent request does
	if me["online"] != true {
		t.Fatalf("session participant should be online: %v", me)
	}

	noSlug := &testClient{t: t, base: srv.URL, token: creator.token}
	if st, out := noSlug.do("GET", "/api/v1/me", nil); st != 400 || out["code"] != "workspace_required" {
		t.Fatalf("missing slug: %d %v", st, out)
	}
	noSlug.slug = "no-such-room"
	if st, _ := noSlug.do("GET", "/api/v1/me", nil); st != 404 {
		t.Fatalf("unknown slug: %d", st)
	}
	noSlug.slug = room["slug"].(string)
	noSlug.token = "ses_notarealsession"
	if st, out := noSlug.do("GET", "/api/v1/me", nil); st != 401 || out["code"] != "session_invalid" {
		t.Fatalf("bad session: %d %v", st, out)
	}

	// opening a second workspace moves the last-active pointer
	second := creator.must("POST", "/api/v1/rooms", map[string]any{"name": "second"}, 201)["room"].(map[string]any)
	creator.slug = second["slug"].(string)
	creator.must("GET", "/api/v1/me", nil, 200)
	if got := creator.must("GET", "/api/v1/user", nil, 200)["user"].(map[string]any)["last_active_workspace_id"]; got != second["id"] {
		t.Fatalf("last_active_workspace_id after switch: %v", got)
	}
	creator.slug = room["slug"].(string)
	creator.must("GET", "/api/v1/me", nil, 200)
	if got := creator.must("GET", "/api/v1/user", nil, 200)["user"].(map[string]any)["last_active_workspace_id"]; got != room["id"] {
		t.Fatalf("last_active_workspace_id after switch back: %v", got)
	}
}

func TestSessionWithoutParticipantIs403(t *testing.T) {
	srv, _ := newTestServer(t)
	_, _, room := sessionRoom(t, srv.URL, "theirs")
	stranger, _ := register(t, srv.URL, uniqUser(), "correct horse")
	stranger.slug = room["slug"].(string)
	st, out := stranger.do("GET", "/api/v1/me", nil)
	if st != 403 || out["code"] != "workspace_forbidden" || out["reason"] != "not_member" {
		t.Fatalf("non-member: %d %v", st, out)
	}
	// a session on a room route never falls through to the act_ path
	if st, _ := stranger.do("POST", "/api/v1/channels/general/messages", map[string]any{"body": "hi"}); st != 403 {
		t.Fatalf("non-member post: %d", st)
	}
}

func TestRevokedHumanIs403FromEnterAndRoom(t *testing.T) {
	srv, _ := newTestServer(t)
	creator, _, room := sessionRoom(t, srv.URL, "kicked")
	member, _ := register(t, srv.URL, uniqUser(), "correct horse")
	member.slug = room["slug"].(string)
	entered := member.must("POST", "/api/v1/workspaces/"+member.slug+"/enter", map[string]any{"invite_code": room["invite_code"]}, 200)
	pid := entered["participant"].(map[string]any)["id"].(string)
	member.must("GET", "/api/v1/me", nil, 200)

	creator.must("DELETE", "/api/v1/participants/"+pid, nil, 200)
	st, out := member.do("GET", "/api/v1/me", nil)
	if st != 403 || out["code"] != "workspace_forbidden" || out["reason"] != "revoked" {
		t.Fatalf("revoked on a room route: %d %v", st, out)
	}
	// a valid code does not reopen the door: the kick is sticky
	st, out = member.do("POST", "/api/v1/workspaces/"+member.slug+"/enter", map[string]any{"invite_code": room["invite_code"]})
	if st != 403 || out["code"] != "workspace_forbidden" || out["reason"] != "revoked" {
		t.Fatalf("revoked on enter: %d %v", st, out)
	}
}

func TestEnterWithInviteCodeCreatesLinkedParticipant(t *testing.T) {
	srv, _ := newTestServer(t)
	_, _, room := sessionRoom(t, srv.URL, "open")
	slug := room["slug"].(string)

	member, reg := registerAs(t, srv.URL, "Newcomer")
	member.slug = slug
	out := member.must("POST", "/api/v1/workspaces/"+slug+"/enter", map[string]any{"invite_code": room["invite_code"]}, 200)
	p := out["participant"].(map[string]any)
	userID := reg["user"].(map[string]any)["id"]
	if p["user_id"] != userID || p["is_human"] != true || p["role"] != "member" || p["name"] != "Newcomer" {
		t.Fatalf("entered participant: %v", p)
	}
	if _, has := out["room"].(map[string]any)["invite_code"]; has {
		t.Fatalf("enter must not echo the invite code: %v", out["room"])
	}
	// idempotent for a live member, no code needed
	again := member.must("POST", "/api/v1/workspaces/"+slug+"/enter", map[string]any{}, 200)
	if again["participant"].(map[string]any)["id"] != p["id"] {
		t.Fatalf("second enter made a new row: %v", again)
	}
	if me := member.must("GET", "/api/v1/me", nil, 200); me["id"] != p["id"] || me["user_id"] != userID {
		t.Fatalf("me after enter: %v", me)
	}
	var payload map[string]any
	if err := testDB(t).QueryRow(context.Background(),
		`SELECT payload FROM events WHERE room_id = $1 AND type = 'participant.joined' AND payload->>'participant_id' = $2`,
		room["id"], p["id"]).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["user_id"] != userID {
		t.Fatalf("participant.joined for /enter: %v", payload)
	}

	// an owner-scoped code opens the room but binds no human to its issuer,
	// as /join does (humans are their own principal); a taken display name
	// gets the -2 suffix
	inv := member.must("POST", "/api/v1/invites", nil, 201)
	third, _ := registerAs(t, srv.URL, "Newcomer")
	third.slug = slug
	tp := third.must("POST", "/api/v1/workspaces/"+slug+"/enter", map[string]any{"invite_code": inv["invite_code"]}, 200)["participant"].(map[string]any)
	if _, has := tp["owner_id"]; has || tp["name"] != "Newcomer-2" {
		t.Fatalf("owner-scoped enter: %v", tp)
	}
	if err := testDB(t).QueryRow(context.Background(),
		`SELECT payload FROM events WHERE room_id = $1 AND type = 'participant.joined' AND payload->>'participant_id' = $2`,
		room["id"], tp["id"]).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["owner_id"] != nil {
		t.Fatalf("participant.joined for an owner-scoped /enter: %v", payload)
	}
}

func TestEnterDoesNotAdoptByName(t *testing.T) {
	srv, store := newTestServer(t)
	_, _, room := sessionRoom(t, srv.URL, "names")
	slug := room["slug"].(string)
	// an unlinked human row with the newcomer's display name, offline
	c := &testClient{t: t, base: srv.URL}
	legacy := c.must("POST", "/api/v1/rooms/join", map[string]any{
		"invite_code": room["invite_code"], "name": "Newcomer", "is_human": true,
	}, 201)["participant"].(map[string]any)
	if err := store.BackdateSeen(context.Background(), legacy["id"].(string)); err != nil {
		t.Fatal(err)
	}

	member, reg := registerAs(t, srv.URL, "Newcomer")
	member.slug = slug
	p := member.must("POST", "/api/v1/workspaces/"+slug+"/enter", map[string]any{"invite_code": room["invite_code"]}, 200)["participant"].(map[string]any)
	if p["id"] == legacy["id"] || p["name"] != "Newcomer-2" || p["user_id"] != reg["user"].(map[string]any)["id"] {
		t.Fatalf("enter adopted or misnamed: %v", p)
	}
	old, err := store.ParticipantByID(context.Background(), room["id"].(string), legacy["id"].(string))
	if err != nil || old.UserID != nil || old.Name != "Newcomer" {
		t.Fatalf("legacy row changed: %+v %v", old, err)
	}
}

func TestEnterWrongCodeIs400(t *testing.T) {
	srv, _ := newTestServer(t)
	_, _, room := sessionRoom(t, srv.URL, "target")
	_, _, other := sessionRoom(t, srv.URL, "elsewhere")
	slug := room["slug"].(string)
	member, _ := register(t, srv.URL, uniqUser(), "correct horse")
	for _, code := range []any{"inv-not-a-code", other["invite_code"], ""} {
		st, out := member.do("POST", "/api/v1/workspaces/"+slug+"/enter", map[string]any{"invite_code": code})
		if st != 400 || out["code"] != "invite_invalid" {
			t.Fatalf("enter with %q: %d %v", code, st, out)
		}
	}
	if st, _ := member.do("POST", "/api/v1/workspaces/no-such-room/enter", map[string]any{"invite_code": room["invite_code"]}); st != 404 {
		t.Fatalf("unknown slug: %d", st)
	}
	member.slug = slug
	if st, out := member.do("GET", "/api/v1/me", nil); st != 403 || out["reason"] != "not_member" {
		t.Fatalf("a failed enter must not create a row: %d %v", st, out)
	}
}

// GET /api/v1/user lists live memberships in join order and points at the
// last-active workspace only while the user is still a live member there.
// Names and room creation both run against the join order, so a sort by
// name, slug or room age would fail the order assertion below.
func TestUserRoomsListsLiveParticipations(t *testing.T) {
	srv, _ := newTestServer(t)
	adminOfSecond, _, second := sessionRoom(t, srv.URL, "alpha")
	adminOfThird, _, third := sessionRoom(t, srv.URL, "mike")
	_, _, first := sessionRoom(t, srv.URL, "zulu")
	userID := ""

	user, reg := register(t, srv.URL, uniqUser(), "correct horse")
	userID = reg["user"].(map[string]any)["id"].(string)
	out := user.must("GET", "/api/v1/user", nil, 200)
	if ws := out["workspaces"].([]any); len(ws) != 0 {
		t.Fatalf("fresh user should have no workspaces: %v", ws)
	}
	if _, has := out["last_active_workspace_id"]; has {
		t.Fatalf("fresh user should have no last_active: %v", out)
	}

	for _, room := range []map[string]any{first, third, second} {
		user.must("POST", "/api/v1/workspaces/"+room["slug"].(string)+"/enter", map[string]any{"invite_code": room["invite_code"]}, 200)
	}
	// open first, then second: last_active follows the most recent room route
	user.slug = first["slug"].(string)
	user.must("GET", "/api/v1/me", nil, 200)
	user.slug = second["slug"].(string)
	user.must("GET", "/api/v1/me", nil, 200)
	kickUser(t, adminOfThird, userID)

	out = user.must("GET", "/api/v1/user", nil, 200)
	ws := out["workspaces"].([]any)
	if len(ws) != 2 {
		t.Fatalf("expected the two live rooms, got %v", ws)
	}
	for i, want := range []map[string]any{first, second} {
		got := ws[i].(map[string]any)
		if got["id"] != want["id"] || got["slug"] != want["slug"] || got["name"] != want["name"] || got["role"] != "member" {
			t.Fatalf("workspace %d: got %v want %v", i, got, want)
		}
		if _, ok := got["joined_at"].(string); !ok {
			t.Fatalf("workspace %d: joined_at missing: %v", i, got)
		}
	}
	if out["last_active_workspace_id"] != second["id"] {
		t.Fatalf("last_active should be second: %v", out["last_active_workspace_id"])
	}
	if out["user"].(map[string]any)["last_active_workspace_id"] != second["id"] {
		t.Fatalf("user.last_active should be second: %v", out["user"])
	}

	// open third: the pointer moves nowhere (revoked), and the hint stays hidden
	// once the user is kicked from the room it points to
	user.slug = third["slug"].(string)
	if st, _ := user.do("GET", "/api/v1/me", nil); st != 403 {
		t.Fatalf("revoked me: %d", st)
	}
	out = user.must("GET", "/api/v1/user", nil, 200)
	if out["last_active_workspace_id"] != second["id"] {
		t.Fatalf("last_active after a revoked open: %v", out["last_active_workspace_id"])
	}
	kickUser(t, adminOfSecond, userID)
	out = user.must("GET", "/api/v1/user", nil, 200)
	if _, has := out["last_active_workspace_id"]; has {
		t.Fatalf("last_active must vanish with the membership: %v", out)
	}
	if _, has := out["user"].(map[string]any)["last_active_workspace_id"]; has {
		t.Fatalf("user.last_active must vanish with the membership: %v", out)
	}
	if ws := out["workspaces"].([]any); len(ws) != 1 || ws[0].(map[string]any)["id"] != first["id"] {
		t.Fatalf("only first should remain: %v", ws)
	}
}

// kickUser revokes userID's row through an admin client already scoped to the room.
func kickUser(t *testing.T, admin *testClient, userID string) {
	t.Helper()
	parts := admin.must("GET", "/api/v1/participants", nil, 200)["participants"].([]any)
	for _, p := range parts {
		if p.(map[string]any)["user_id"] == userID {
			admin.must("DELETE", "/api/v1/participants/"+p.(map[string]any)["id"].(string), nil, 200)
			return
		}
	}
	t.Fatalf("user row missing in %s: %v", admin.slug, parts)
}

// Agents and anonymous callers have no account behind GET /api/v1/user.
func TestUserRouteRequiresSession(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, _ := setupRoom(t, srv.URL)
	if st, out := alice.do("GET", "/api/v1/user", nil); st != 401 || out["code"] != "session_required" {
		t.Fatalf("act_ on /user: %d %v", st, out)
	}
	anon := &testClient{t: t, base: srv.URL}
	if st, out := anon.do("GET", "/api/v1/user", nil); st != 401 || out["code"] != "session_required" {
		t.Fatalf("anon on /user: %d %v", st, out)
	}
}
