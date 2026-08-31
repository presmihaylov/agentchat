package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/presmihaylov/agentchat/models"
)

// Integration tests over real HTTP + the docker compose db (make db-up); skip otherwise.

type testClient struct {
	t     *testing.T
	base  string
	token string
}

func newTestServer(t *testing.T) (*httptest.Server, *models.Store) {
	t.Helper()
	url := os.Getenv("AGENTCHAT_TEST_DB_URL")
	if url == "" {
		url = "postgres://agentchat:agentchat@localhost:5477/agentchat?sslmode=disable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	store, err := models.Open(ctx, url)
	if err != nil {
		t.Skipf("db unavailable: %v", err)
	}
	t.Cleanup(store.Close)

	srv := httptest.NewServer(New(store, Config{PublicURL: "http://public.test"}).Handler())
	t.Cleanup(srv.Close)
	return srv, store
}

func (c *testClient) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		c.t.Fatal(err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	raw, _ := io.ReadAll(resp.Body)
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			c.t.Fatalf("bad json response (%d): %s", resp.StatusCode, raw)
		}
	}
	return resp.StatusCode, out
}

func (c *testClient) must(method, path string, body any, wantStatus int) map[string]any {
	c.t.Helper()
	status, out := c.do(method, path, body)
	if status != wantStatus {
		c.t.Fatalf("%s %s: got %d want %d: %v", method, path, status, wantStatus, out)
	}
	return out
}

func setupRoom(t *testing.T, base string) (secret string, alice, bob *testClient) {
	t.Helper()
	c := &testClient{t: t, base: base}
	out := c.must("POST", "/api/v1/rooms", map[string]any{"name": "test room"}, 201)
	secret = out["invite_code"].(string)
	if !strings.HasPrefix(out["join_url"].(string), "http://public.test/r/") {
		t.Fatalf("bad join_url: %v", out["join_url"])
	}
	if strings.Contains(out["join_url"].(string), secret) {
		t.Fatalf("join_url leaks the invite code: %v", out["join_url"])
	}

	join := func(name string, human bool) *testClient {
		cc := &testClient{t: t, base: base}
		out := cc.must("POST", "/api/v1/rooms/join", map[string]any{
			"invite_code": secret, "name": name, "description": name + " the test agent", "is_human": human,
		}, 201)
		cc.token = out["token"].(string)
		return cc
	}
	return secret, join("alice", false), join("bob", false)
}

func TestFullFlow(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, alice, bob := setupRoom(t, srv.URL)

	// duplicate name rejected (legacy "secret" field still accepted), bad code 404
	c := &testClient{t: t, base: srv.URL}
	c.must("POST", "/api/v1/rooms/join", map[string]any{
		"secret": secret, "name": "alice",
	}, 409)
	c.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": "wrong-code", "name": "eve"}, 404)

	// room overview
	out := alice.must("GET", "/api/v1/room", nil, 200)
	if n := len(out["participants"].([]any)); n != 2 {
		t.Fatalf("want 2 participants, got %d", n)
	}

	// peek by public slug; peeking by invite code must not work
	slug := out["room"].(map[string]any)["slug"].(string)
	peek := c.must("GET", "/api/v1/rooms/peek?slug="+slug, nil, 200)
	if peek["name"] != "test room" {
		t.Fatalf("peek: %v", peek)
	}
	c.must("GET", "/api/v1/rooms/peek?slug="+secret, nil, 404)

	// unauthenticated
	anon := &testClient{t: t, base: srv.URL}
	if status, _ := anon.do("GET", "/api/v1/room", nil); status != 401 {
		t.Fatal("expected 401 for missing token")
	}

	// profile update
	desc := "updated"
	out = alice.must("PATCH", "/api/v1/me", map[string]any{"description": desc}, 200)
	if out["description"] != desc {
		t.Fatalf("profile update: %v", out)
	}

	// channels
	ch := alice.must("POST", "/api/v1/channels", map[string]any{"name": "#Deploys", "topic": "ship it"}, 201)
	if ch["name"] != "deploys" {
		t.Fatalf("channel name not normalized: %v", ch)
	}
	alice.must("POST", "/api/v1/channels", map[string]any{"name": "deploys"}, 409)

	// events cursor before the action
	cur := alice.must("GET", "/api/v1/events", nil, 200)
	cursor := int64(cur["cursor"].(float64))

	// attachment upload + message with mention
	attID := uploadFile(t, srv.URL, alice.token, "report.txt", "quarterly numbers inside")
	msg := alice.must("POST", "/api/v1/channels/deploys/messages", map[string]any{
		"body":           "hey @bob deploy is done, see attached. @channel",
		"attachment_ids": []string{attID},
	}, 201)
	msgID := msg["id"].(string)
	if msg["is_broadcast"] != true {
		t.Fatalf("expected broadcast from @channel: %v", msg)
	}
	mentionsList := msg["mentions"].([]any)
	if len(mentionsList) != 1 || mentionsList[0] != "bob" {
		t.Fatalf("mentions: %v", mentionsList)
	}

	// thread reply via channel name, nesting collapses to root
	reply := bob.must("POST", "/api/v1/channels/deploys/messages", map[string]any{
		"body": "confirmed working", "thread_root_id": msgID,
	}, 201)
	reply2 := alice.must("POST", "/api/v1/channels/deploys/messages", map[string]any{
		"body": "replying to a reply", "thread_root_id": reply["id"].(string),
	}, 201)
	if reply2["thread_root_id"] != msgID {
		t.Fatalf("nested reply should attach to root: %v", reply2["thread_root_id"])
	}

	// listing: one top-level with 2 replies
	list := bob.must("GET", "/api/v1/channels/deploys/messages", nil, 200)
	msgs := list["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["reply_count"].(float64) != 2 {
		t.Fatalf("channel listing: %v", msgs)
	}

	thread := bob.must("GET", "/api/v1/threads/"+msgID, nil, 200)
	if len(thread["messages"].([]any)) != 3 {
		t.Fatalf("thread: %v", thread)
	}

	// attachment download
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/attachments/"+attID, nil)
	req.Header.Set("Authorization", "Bearer "+bob.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(data) != "quarterly numbers inside" {
		t.Fatalf("attachment content: %q", data)
	}

	// events after cursor include message.created
	ev := alice.must("GET", fmt.Sprintf("/api/v1/events?after=%d", cursor), nil, 200)
	found := false
	for _, e := range ev["events"].([]any) {
		if e.(map[string]any)["type"] == "message.created" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no message.created event after cursor: %v", ev)
	}

	// tags
	out = alice.must("POST", "/api/v1/participants/bob/tags", map[string]any{"tag": "Deployer"}, 200)
	tags := out["tags"].([]any)
	if len(tags) != 1 || tags[0].(map[string]any)["tag"] != "deployer" {
		t.Fatalf("tags: %v", tags)
	}
	alice.must("DELETE", "/api/v1/participants/bob/tags/deployer", nil, 200)

	// presence
	bob.must("POST", "/api/v1/me/offline", nil, 200)
	me := bob.must("GET", "/api/v1/me", nil, 200)
	// note: GET /me itself touches presence, but Online is computed in the same
	// query before the touch of THIS request? authed touches first, so online again.
	if me["online"] != true {
		t.Fatalf("expected online after new request, got %v", me["online"])
	}

	// text search with filters
	res := alice.must("GET", "/api/v1/search?q=deploy&channel=deploys&author=alice", nil, 200)
	if len(res["results"].([]any)) != 1 {
		t.Fatalf("search: %v", res)
	}
	res = alice.must("GET", "/api/v1/search?q=deploy&author=bob", nil, 200)
	if len(res["results"].([]any)) != 0 {
		t.Fatalf("search author filter: %v", res)
	}

	// semantic search disabled without embedder
	if status, _ := alice.do("GET", "/api/v1/search/semantic?q=deploy", nil); status != 503 {
		t.Fatalf("expected 503 semantic disabled, got %d", status)
	}

	// archived channel rejects posts
	chID := ch["id"].(string)
	alice.must("PATCH", "/api/v1/channels/"+chID, map[string]any{"archived": true}, 200)
	alice.must("POST", "/api/v1/channels/deploys/messages", map[string]any{"body": "nope"}, 409)
}

func TestEventsLongPoll(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, bob := setupRoom(t, srv.URL)

	cur := alice.must("GET", "/api/v1/events", nil, 200)
	cursor := int64(cur["cursor"].(float64))

	done := make(chan map[string]any, 1)
	go func() {
		out := alice.must("GET", fmt.Sprintf("/api/v1/events?after=%d&wait=10", cursor), nil, 200)
		done <- out
	}()

	time.Sleep(300 * time.Millisecond)
	bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "wake up"}, 201)

	select {
	case out := <-done:
		evs := out["events"].([]any)
		if len(evs) == 0 {
			t.Fatalf("long-poll returned no events")
		}
	case <-time.After(8 * time.Second):
		t.Fatal("long-poll did not wake up")
	}
}

func uploadFile(t *testing.T, base, token, name, content string) string {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	mw.Close()

	req, err := http.NewRequest("POST", base+"/api/v1/attachments", &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 201 {
		t.Fatalf("upload failed: %d %v", resp.StatusCode, out)
	}
	return out["id"].(string)
}

// TestRolesAndModeration covers the Slack-style permission model end to end:
// first-joiner admin, promote/demote, kick, last-admin guard, channel
// archive/delete rules, message edit/delete rules, rename, secret rotation.
func TestRolesAndModeration(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, alice, bob := setupRoom(t, srv.URL)

	// first joiner is admin, second is member
	me := alice.must("GET", "/api/v1/me", nil, 200)
	if me["role"] != "admin" {
		t.Fatalf("alice role = %v, want admin", me["role"])
	}
	if bob.must("GET", "/api/v1/me", nil, 200)["role"] != "member" {
		t.Fatal("bob should be a member")
	}

	// member cannot do admin things
	bob.must("PATCH", "/api/v1/room", map[string]any{"name": "hijacked"}, 403)
	bob.must("POST", "/api/v1/room/rotate-secret", nil, 403)
	bob.must("POST", "/api/v1/participants/alice/role", map[string]any{"role": "member"}, 403)
	bob.must("DELETE", "/api/v1/participants/alice", nil, 403)

	// admin renames the room
	room := alice.must("PATCH", "/api/v1/room", map[string]any{"name": "renamed room"}, 200)
	if room["name"] != "renamed room" {
		t.Fatalf("rename failed: %v", room)
	}

	// channel rules: bob creates one, carol (member) cannot archive it, bob (creator) can
	cc := &testClient{t: t, base: srv.URL}
	out := cc.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": secret, "name": "carol"}, 201)
	cc.token = out["token"].(string)

	bob.must("POST", "/api/v1/channels", map[string]any{"name": "bobs-place"}, 201)
	cc.must("PATCH", "/api/v1/channels/bobs-place", map[string]any{"archived": true}, 403)
	bob.must("PATCH", "/api/v1/channels/bobs-place", map[string]any{"archived": true}, 200)
	alice.must("PATCH", "/api/v1/channels/bobs-place", map[string]any{"archived": false}, 200)

	// general is protected from archive and delete, even for admins
	alice.must("PATCH", "/api/v1/channels/general", map[string]any{"archived": true}, 409)
	alice.must("DELETE", "/api/v1/channels/general", nil, 409)

	// delete: member no, admin yes
	bob.must("DELETE", "/api/v1/channels/bobs-place", nil, 403)
	alice.must("DELETE", "/api/v1/channels/bobs-place", nil, 200)
	alice.must("GET", "/api/v1/channels/bobs-place/messages", nil, 404)

	// message edit/delete rules
	msg := bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "draft one"}, 201)
	msgID := msg["id"].(string)
	alice.must("PATCH", "/api/v1/messages/"+msgID, map[string]any{"body": "not yours"}, 403)
	edited := bob.must("PATCH", "/api/v1/messages/"+msgID, map[string]any{"body": "draft two"}, 200)
	if edited["body"] != "draft two" || edited["edited_at"] == nil {
		t.Fatalf("edit failed: %v", edited)
	}
	cc.must("DELETE", "/api/v1/messages/"+msgID, nil, 403) // carol: not author, not admin
	alice.must("DELETE", "/api/v1/messages/"+msgID, nil, 200)
	bob.must("GET", "/api/v1/messages/"+msgID, nil, 404)

	// deleting a thread root removes its replies
	root := bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "root"}, 201)
	rootID := root["id"].(string)
	reply := bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "reply", "thread_root_id": rootID}, 201)
	bob.must("DELETE", "/api/v1/messages/"+rootID, nil, 200)
	bob.must("GET", "/api/v1/messages/"+reply["id"].(string), nil, 404)

	// promote bob, then last-admin guard: alice is protected only if she's the last admin
	alice.must("POST", "/api/v1/participants/bob/role", map[string]any{"role": "admin"}, 200)
	alice.must("POST", "/api/v1/participants/alice/role", map[string]any{"role": "member"}, 200)
	// now bob is the only admin; demoting him must fail
	bob.must("POST", "/api/v1/participants/bob/role", map[string]any{"role": "member"}, 409)

	// kick: admin revokes carol; her token stops working, her messages survive
	kicked := cc.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "carol was here"}, 201)
	bob.must("DELETE", "/api/v1/participants/carol", nil, 200)
	cc.must("GET", "/api/v1/me", nil, 401)
	bob.must("GET", "/api/v1/messages/"+kicked["id"].(string), nil, 200)

	// last admin cannot leave
	bob.must("DELETE", "/api/v1/participants/me", nil, 409)
	// a member can leave on their own
	alice.must("DELETE", "/api/v1/participants/me", nil, 200)
	alice.must("GET", "/api/v1/me", nil, 401)

	// rotate secret: old secret dies, new one works
	rot := bob.must("POST", "/api/v1/room/rotate-secret", nil, 200)
	newSecret := rot["invite_code"].(string)
	if newSecret == secret {
		t.Fatal("secret did not change")
	}
	dead := &testClient{t: t, base: srv.URL}
	dead.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": secret, "name": "late"}, 404)
	fresh := &testClient{t: t, base: srv.URL}
	fresh.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": newSecret, "name": "late"}, 201)
}

func TestEventFiltering(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, bob := setupRoom(t, srv.URL)

	cursor := func(c *testClient) string {
		out := c.must("GET", "/api/v1/events", nil, 200)
		return fmt.Sprintf("%.0f", out["cursor"].(float64))
	}
	c0 := cursor(bob)

	// irrelevant to bob: plain top-level message, no mention, no thread
	plain := alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "just musing"}, 201)

	// relevant=true returns nothing but still advances the cursor past it
	out := bob.must("GET", "/api/v1/events?after="+c0+"&relevant=true", nil, 200)
	if n := len(out["events"].([]any)); n != 0 {
		t.Fatalf("plain message leaked through relevant filter: %v", out["events"])
	}
	if fmt.Sprintf("%.0f", out["cursor"].(float64)) == c0 {
		t.Fatal("cursor did not advance past filtered events")
	}

	// relevant to bob: broadcast, direct mention, and a thread he wrote in
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "@channel heads up"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "hey @bob"}, 201)
	bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "my reply", "thread_root_id": plain["id"].(string)}, 201)
	// another irrelevant top-level message mixed in between relevant ones
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "more musing"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "in-thread answer", "thread_root_id": plain["id"].(string)}, 201)

	out = bob.must("GET", "/api/v1/events?after="+c0+"&relevant=true", nil, 200)
	bodies := []string{}
	for _, e := range out["events"].([]any) {
		ev := e.(map[string]any)
		if ev["type"] != "message.created" {
			t.Fatalf("relevant filter returned non-message event: %v", ev["type"])
		}
		bodies = append(bodies, ev["payload"].(map[string]any)["body"].(string))
	}
	want := []string{"@channel heads up", "hey @bob", "my reply", "in-thread answer"}
	if fmt.Sprint(bodies) != fmt.Sprint(want) {
		t.Fatalf("relevant events = %v, want %v", bodies, want)
	}

	// types filter
	out = bob.must("GET", "/api/v1/events?after="+c0+"&types=participant.joined", nil, 200)
	if n := len(out["events"].([]any)); n != 0 {
		t.Fatalf("types filter leaked: %v", out["events"])
	}
	out = bob.must("GET", "/api/v1/events?after="+c0+"&types=message.created", nil, 200)
	if n := len(out["events"].([]any)); n != 6 {
		t.Fatalf("types=message.created returned %d events, want 6", n)
	}
}

func postAvatar(t *testing.T, base, token string, content []byte) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", "pic.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatal(err)
	}
	mw.Close()
	req, err := http.NewRequest("POST", base+"/api/v1/me/avatar", &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestAvatarUpload(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, _ := setupRoom(t, srv.URL)

	// tiny valid PNG header so content sniffing sees image/png
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	status, out := postAvatar(t, srv.URL, alice.token, png)
	if status != 200 {
		t.Fatalf("avatar upload: got %d %v", status, out)
	}
	attID, _ := out["avatar_attachment_id"].(string)
	if attID == "" {
		t.Fatalf("no avatar_attachment_id in response: %v", out)
	}

	// the image is readable through the normal attachments endpoint
	alice.must("GET", "/api/v1/participants/alice", nil, 200)
	me := alice.must("GET", "/api/v1/me", nil, 200)
	if me["avatar_attachment_id"] != attID {
		t.Fatalf("me does not show avatar: %v", me["avatar_attachment_id"])
	}

	// non-images are rejected
	status, out = postAvatar(t, srv.URL, alice.token, []byte("just text, not an image"))
	if status != 400 {
		t.Fatalf("text upload: got %d %v, want 400", status, out)
	}

	// remove reverts to emoji
	me = alice.must("DELETE", "/api/v1/me/avatar", nil, 200)
	if _, has := me["avatar_attachment_id"]; has {
		t.Fatalf("avatar_attachment_id should be gone: %v", me)
	}
}

func TestUnreadCounts(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()
	_, alice, bob := setupRoom(t, srv.URL)

	getUnread := func(c *testClient, name string) (float64, bool) {
		out := c.must("GET", "/api/v1/channels", nil, 200)
		for _, raw := range out["channels"].([]any) {
			ch := raw.(map[string]any)
			if ch["name"] == name {
				_, hasMark := ch["last_read_at"]
				return ch["unread_count"].(float64), hasMark
			}
		}
		t.Fatalf("channel %s not found", name)
		return 0, false
	}

	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "one"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "two"}, 201)

	if n, _ := getUnread(bob, "general"); n != 2 {
		t.Fatalf("bob unread = %v, want 2", n)
	}
	// own messages never count as unread
	if n, _ := getUnread(alice, "general"); n != 0 {
		t.Fatalf("alice unread = %v, want 0", n)
	}

	bob.must("POST", "/api/v1/channels/general/read", nil, 200)
	if n, hasMark := getUnread(bob, "general"); n != 0 || !hasMark {
		t.Fatalf("after read: unread=%v hasMark=%v, want 0/true", n, hasMark)
	}

	// a thread reply must not bump the channel counter
	msg := alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "root"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "reply", "thread_root_id": msg["id"]}, 201)
	if n, _ := getUnread(bob, "general"); n != 1 {
		t.Fatalf("after root+reply: unread=%v, want 1 (thread replies don't count)", n)
	}
}
