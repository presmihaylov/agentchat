package api

import (
	"context"
	"testing"
	"time"

	"github.com/presmihaylov/agentchat/models"
)

// backdate moves a workspace's (and optionally one channel's) expiry into the
// past without waiting: the API has no route for that on purpose.
func backdateRoom(t *testing.T, roomID string, by time.Duration) {
	t.Helper()
	if _, err := testDB(t).Exec(context.Background(),
		`UPDATE rooms SET expires_at = now() - $2::interval WHERE id = $1`, roomID, by.String()); err != nil {
		t.Fatal(err)
	}
}

func TestExpiryCreateAndPatch(t *testing.T) {
	srv, _ := newTestServer(t)
	creator, _ := register(t, srv.URL, uniqUser(), "correct horse")

	// validation on create
	body := roomBody("ttl room")
	body["expiresInSeconds"] = 30
	creator.must("POST", "/api/v1/rooms", body, 400)
	body["expiresInSeconds"] = 3600
	out := creator.must("POST", "/api/v1/rooms", body, 201)
	room := out["room"].(map[string]any)
	if room["expires_at"] == nil || room["expired"] != false || room["purge_at"] == nil {
		t.Fatalf("room create with ttl: %v", room)
	}
	secret := out["invite_code"].(string)
	join := func(name string) *testClient {
		c := &testClient{t: t, base: srv.URL}
		o := c.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": secret, "name": name}, 201)
		c.token = o["token"].(string)
		return c
	}
	admin := join("admin")
	// the first agent in is admin only when no human holds the room; promote via the creator instead
	creator.slug = room["slug"].(string)
	me := admin.must("GET", "/api/v1/me", nil, 200)
	creator.must("POST", "/api/v1/participants/"+me["id"].(string)+"/role", map[string]any{"role": "admin"}, 200)
	bob := join("bob")

	// members cannot set the workspace expiry, admins can; 0 clears
	bob.must("PATCH", "/api/v1/room", map[string]any{"expiresInSeconds": 600}, 403)
	got := admin.must("PATCH", "/api/v1/room", map[string]any{"expiresInSeconds": 0}, 200)
	if got["expires_at"] != nil || got["purge_at"] != nil {
		t.Fatalf("clear: %v", got)
	}
	admin.must("PATCH", "/api/v1/room", map[string]any{"expiresInSeconds": 99999999}, 400)
	got = admin.must("PATCH", "/api/v1/room", map[string]any{"expiresInSeconds": 600}, 200)
	if got["expires_at"] == nil {
		t.Fatalf("set: %v", got)
	}
	if e := lastSystemEntry(t, admin, "general"); e["body"] != "set the workspace to expire on "+mustParse(t, got["expires_at"].(string)).Format("2006-01-02 15:04 UTC") {
		t.Fatalf("general line: %v", e["body"])
	}

	// channels: create with ttl, patch by creator, general refuses
	ch := bob.must("POST", "/api/v1/channels", map[string]any{"name": "short", "expiresInSeconds": 120}, 201)
	if ch["expires_at"] == nil || ch["expired"] != false {
		t.Fatalf("channel create with ttl: %v", ch)
	}
	bob.must("POST", "/api/v1/channels", map[string]any{"name": "bad", "expiresInSeconds": 5}, 400)
	bob.must("PATCH", "/api/v1/channels/short", map[string]any{"expiresInSeconds": 0}, 200)
	admin.must("PATCH", "/api/v1/channels/general", map[string]any{"expiresInSeconds": 600}, 409)
	c2 := admin.must("PATCH", "/api/v1/channels/short", map[string]any{"expiresInSeconds": 600}, 200)
	if c2["expires_at"] == nil {
		t.Fatalf("channel set: %v", c2)
	}
	if e := lastSystemEntry(t, bob, "short"); e["body"] == nil || e["body"].(string)[:26] != "set the channel to expire " {
		t.Fatalf("channel line: %v", e["body"])
	}
}

func mustParse(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return ts.UTC()
}

func TestExpiredWorkspaceIsReadOnly(t *testing.T) {
	srv, store := newTestServer(t)
	secret, alice, bob := setupRoom(t, srv.URL) // alice is admin
	alice.must("POST", "/api/v1/channels", map[string]any{"name": "ops"}, 201)
	bob.must("POST", "/api/v1/channels/ops/join", nil, 200)
	msg := bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "before"}, 201)
	roomID := alice.must("GET", "/api/v1/room", nil, 200)["room"].(map[string]any)["id"].(string)
	alice.must("PATCH", "/api/v1/room", map[string]any{"expiresInSeconds": 600}, 200)
	backdateRoom(t, roomID, time.Minute)

	// nobody new gets in: a join with the code and a member removal both answer 409
	joiner := &testClient{t: t, base: srv.URL}
	out := joiner.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": secret, "name": "late"}, 409)
	if out["code"] != "workspace_expired" {
		t.Fatalf("join on an expired workspace: %v", out)
	}

	// reads and the flags
	room := bob.must("GET", "/api/v1/room", nil, 200)["room"].(map[string]any)
	if room["expired"] != true {
		t.Fatalf("expired flag: %v", room)
	}
	bob.must("GET", "/api/v1/channels/general/messages", nil, 200)
	bob.must("GET", "/api/v1/events?after=0", nil, 200)
	bob.must("GET", "/api/v1/me/inbox?peek=1", nil, 200)

	// writes: 409 workspace_expired
	for _, w := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/v1/channels/general/messages", map[string]any{"body": "after"}},
		{"POST", "/api/v1/channels", map[string]any{"name": "late"}},
		{"PATCH", "/api/v1/messages/" + msg["id"].(string), map[string]any{"body": "edited"}},
		{"POST", "/api/v1/messages/" + msg["id"].(string) + "/reactions", map[string]any{"emoji": "👀"}},
		{"POST", "/api/v1/channels/ops/join", nil},
		{"PATCH", "/api/v1/me", map[string]any{"description": "new"}},
		{"POST", "/api/v1/invites", map[string]any{}},
	} {
		status, out := alice.do(w.method, w.path, w.body)
		if status != 409 || out["code"] != "workspace_expired" {
			t.Fatalf("%s %s on an expired workspace: %d %v", w.method, w.path, status, out)
		}
	}
	// a rename is a write too, even for the admin; the expiry itself is not
	if status, out := alice.do("PATCH", "/api/v1/room", map[string]any{"name": "renamed"}); status != 409 || out["code"] != "workspace_expired" {
		t.Fatalf("rename on expired: %d %v", status, out)
	}
	if status, out := alice.do("PATCH", "/api/v1/channels/ops", map[string]any{"private": true}); status != 409 || out["code"] != "workspace_expired" {
		t.Fatalf("channel change on expired: %d %v", status, out)
	}
	// still allowed: read marks, mute, presence, leave
	bob.must("POST", "/api/v1/channels/general/read", nil, 200)
	bob.must("POST", "/api/v1/channels/general/mute", map[string]any{"muted": true}, 200)
	if st, _ := bob.do("POST", "/api/v1/me/heartbeat", nil); st >= 300 {
		t.Fatalf("heartbeat on expired: %d", st)
	}

	// the sweeper announces it once
	if _, _, err := store.SweepExpiry(context.Background(), models.ExpiryHooks{}); err != nil {
		t.Fatal(err)
	}
	evs, _ := eventsAfter(t, bob, 0)
	n := 0
	for _, e := range evs {
		if e["type"] == "room.expired" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("room.expired events: %d", n)
	}

	// revive: the admin extends, writes work again
	got := alice.must("PATCH", "/api/v1/room", map[string]any{"expiresInSeconds": 3600}, 200)
	if got["expired"] != false {
		t.Fatalf("revive: %v", got)
	}
	bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "after revive"}, 201)

	// and DELETE room is not behind the gate: the owner check answers, not 409
	backdateRoom(t, roomID, time.Minute)
	if status, out := alice.do("DELETE", "/api/v1/room", nil); status != 403 || out["code"] != "owner_required" {
		t.Fatalf("delete on expired: %d %v", status, out)
	}
}

func TestExpiredChannelIsReadOnly(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, bob := setupRoom(t, srv.URL)
	ch := alice.must("POST", "/api/v1/channels", map[string]any{"name": "short", "expiresInSeconds": 600}, 201)
	bob.must("POST", "/api/v1/channels/short/join", nil, 200)
	msg := bob.must("POST", "/api/v1/channels/short/messages", map[string]any{"body": "before"}, 201)
	if _, err := testDB(t).Exec(context.Background(),
		`UPDATE channels SET expires_at = now() - interval '1 minute' WHERE id = $1`, ch["id"]); err != nil {
		t.Fatal(err)
	}
	if c := bob.must("GET", "/api/v1/channels", nil, 200); !channelExpired(c["channels"].([]any), "short") {
		t.Fatalf("list lacks expired flag: %v", c)
	}
	for _, w := range []struct {
		as           *testClient
		method, path string
		body         any
	}{
		{bob, "POST", "/api/v1/channels/short/messages", map[string]any{"body": "after"}},
		{bob, "PATCH", "/api/v1/messages/" + msg["id"].(string), map[string]any{"body": "edited"}},
		{bob, "POST", "/api/v1/messages/" + msg["id"].(string) + "/reactions", map[string]any{"emoji": "👀"}},
		{alice, "PATCH", "/api/v1/channels/short", map[string]any{"name": "renamed"}},
	} {
		status, out := w.as.do(w.method, w.path, w.body)
		if status != 409 || out["code"] != "channel_expired" {
			t.Fatalf("%s %s on an expired channel: %d %v", w.method, w.path, status, out)
		}
	}
	// the rest of the workspace is fine, and the channel can be revived
	bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "elsewhere"}, 201)
	alice.must("PATCH", "/api/v1/channels/short", map[string]any{"expiresInSeconds": 0}, 200)
	bob.must("POST", "/api/v1/channels/short/messages", map[string]any{"body": "revived"}, 201)
}

func channelExpired(chs []any, name string) bool {
	for _, c := range chs {
		m := c.(map[string]any)
		if m["name"] == name {
			return m["expired"] == true
		}
	}
	return false
}
