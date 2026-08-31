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

	getUnread := func(c *testClient, name string) (float64, float64, bool) {
		out := c.must("GET", "/api/v1/channels", nil, 200)
		for _, raw := range out["channels"].([]any) {
			ch := raw.(map[string]any)
			if ch["name"] == name {
				_, hasMark := ch["last_read_at"]
				return ch["unread_count"].(float64), ch["unread_mentions"].(float64), hasMark
			}
		}
		t.Fatalf("channel %s not found", name)
		return 0, 0, false
	}

	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "one"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "two"}, 201)

	// plain messages: unread but no mention
	if n, m, _ := getUnread(bob, "general"); n != 2 || m != 0 {
		t.Fatalf("bob unread=%v mentions=%v, want 2/0", n, m)
	}
	// own messages never count as unread
	if n, _, _ := getUnread(alice, "general"); n != 0 {
		t.Fatalf("alice unread = %v, want 0", n)
	}

	bob.must("POST", "/api/v1/channels/general/read", nil, 200)
	if n, m, hasMark := getUnread(bob, "general"); n != 0 || m != 0 || !hasMark {
		t.Fatalf("after read: unread=%v mentions=%v hasMark=%v, want 0/0/true", n, m, hasMark)
	}

	// a direct @mention and a @channel broadcast both count as mentions
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "hey @bob"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "@channel ping"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "nobody here"}, 201)
	if n, m, _ := getUnread(bob, "general"); n != 3 || m != 2 {
		t.Fatalf("after mentions: unread=%v mentions=%v, want 3/2", n, m)
	}
	// a mention aimed at alice is not a mention for bob
	if _, m, _ := getUnread(alice, "general"); m != 0 {
		t.Fatalf("alice mentions=%v, want 0 (mentions were for bob/channel)", m)
	}

	bob.must("POST", "/api/v1/channels/general/read", nil, 200)

	// a thread reply must not bump the channel counter, mention or not
	msg := alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "root"}, 201)
	alice.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "reply @bob", "thread_root_id": msg["id"]}, 201)
	if n, m, _ := getUnread(bob, "general"); n != 1 || m != 0 {
		t.Fatalf("after root+reply: unread=%v mentions=%v, want 1/0 (thread replies don't count)", n, m)
	}
}

func TestThreadTree(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()
	_, alice, bob := setupRoom(t, srv.URL)

	threadsOf := func(c *testClient) []map[string]any {
		out := c.must("GET", "/api/v1/channels/general/threads", nil, 200)
		list := []map[string]any{}
		for _, raw := range out["threads"].([]any) {
			list = append(list, raw.(map[string]any))
		}
		return list
	}

	root := alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "topic"}, 201)
	rootID := root["id"].(string)
	bob.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "reply from bob", "thread_root_id": rootID}, 201)

	// alice started it, bob replied — both are involved; alice has 1 unread
	at, bt := threadsOf(alice), threadsOf(bob)
	if len(at) != 1 || len(bt) != 1 {
		t.Fatalf("thread counts: alice=%d bob=%d, want 1/1", len(at), len(bt))
	}
	if at[0]["unread_count"].(float64) != 1 || bt[0]["unread_count"].(float64) != 0 {
		t.Fatalf("unread: alice=%v bob=%v, want 1/0", at[0]["unread_count"], bt[0]["unread_count"])
	}

	// reading clears the counter
	alice.must("POST", "/api/v1/threads/"+rootID+"/read", nil, 200)
	if n := threadsOf(alice)[0]["unread_count"].(float64); n != 0 {
		t.Fatalf("after read: unread=%v, want 0", n)
	}

	// mute survives a plain reply...
	alice.must("POST", "/api/v1/threads/"+rootID+"/mute", map[string]any{"muted": true}, 200)
	bob.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "another reply", "thread_root_id": rootID}, 201)
	if th := threadsOf(alice)[0]; th["muted"].(bool) != true {
		t.Fatalf("mute did not survive a plain reply")
	}

	// ...but a direct @mention breaks it
	bob.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "hey @alice look", "thread_root_id": rootID}, 201)
	if th := threadsOf(alice)[0]; th["muted"].(bool) != false {
		t.Fatalf("@mention did not break the mute")
	}

	// mute via a reply id resolves to the root
	alice.must("POST", "/api/v1/threads/"+rootID+"/mute", map[string]any{"muted": false}, 200)

	// an uninvolved thread stays out of the tree
	other := &testClient{t: t, base: srv.URL}
	_ = other
	root2 := bob.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "bob only"}, 201)
	bob.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "bob solo reply", "thread_root_id": root2["id"]}, 201)
	if n := len(threadsOf(alice)); n != 1 {
		t.Fatalf("alice sees %d threads, want 1 (not involved in bob's)", n)
	}
}

// TestRoomThreads: the room-wide thread endpoint returns the caller's involved
// threads across every channel, each tagged with its channel_id, and per-thread
// unread_mentions follows the mention-only rule (direct + broadcast).
func TestRoomThreads(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()
	_, alice, bob := setupRoom(t, srv.URL)

	chanID := func(name string) string {
		out := alice.must("GET", "/api/v1/channels", nil, 200)
		for _, raw := range out["channels"].([]any) {
			ch := raw.(map[string]any)
			if ch["name"] == name {
				return ch["id"].(string)
			}
		}
		t.Fatalf("channel %s not found", name)
		return ""
	}
	roomThreads := func(c *testClient) map[string]map[string]any {
		out := c.must("GET", "/api/v1/threads", nil, 200)
		byRoot := map[string]map[string]any{}
		for _, raw := range out["threads"].([]any) {
			th := raw.(map[string]any)
			byRoot[th["root_id"].(string)] = th
		}
		return byRoot
	}

	alice.must("POST", "/api/v1/channels", map[string]any{"name": "proj"}, 201)
	generalID, projID := chanID("general"), chanID("proj")

	// thread A in general: bob replies (involved), then alice @mentions bob in it
	rootA := alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "topic A"}, 201)
	bob.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "bob in A", "thread_root_id": rootA["id"]}, 201)
	alice.must("POST", "/api/v1/channels/general/messages",
		map[string]any{"body": "hey @bob", "thread_root_id": rootA["id"]}, 201)

	// thread B in proj: bob replies; alice adds a plain reply (unread, no mention)
	rootB := alice.must("POST", "/api/v1/channels/proj/messages", map[string]any{"body": "topic B"}, 201)
	bob.must("POST", "/api/v1/channels/proj/messages",
		map[string]any{"body": "bob in B", "thread_root_id": rootB["id"]}, 201)
	alice.must("POST", "/api/v1/channels/proj/messages",
		map[string]any{"body": "plain follow-up", "thread_root_id": rootB["id"]}, 201)

	ts := roomThreads(bob)
	if len(ts) != 2 {
		t.Fatalf("bob room threads = %d, want 2 (one per channel)", len(ts))
	}
	a, b := ts[rootA["id"].(string)], ts[rootB["id"].(string)]
	if a == nil || b == nil {
		t.Fatalf("missing a thread: %v", ts)
	}
	if a["channel_id"] != generalID || b["channel_id"] != projID {
		t.Fatalf("channel tags wrong: A=%v (want %v) B=%v (want %v)", a["channel_id"], generalID, b["channel_id"], projID)
	}
	// A has a direct @bob -> 1 mention; B is plain -> 0 mentions (but still unread)
	if a["unread_mentions"].(float64) != 1 {
		t.Fatalf("thread A unread_mentions=%v, want 1", a["unread_mentions"])
	}
	if b["unread_mentions"].(float64) != 0 || b["unread_count"].(float64) == 0 {
		t.Fatalf("thread B mentions=%v unread=%v, want 0/>0", b["unread_mentions"], b["unread_count"])
	}
}

func TestReclaimIdentity(t *testing.T) {
	srv, store := newTestServer(t)
	secret, alice, bob := setupRoom(t, srv.URL)

	pid := func(c *testClient, name string) (roomID, id string) {
		t.Helper()
		out := c.must("GET", "/api/v1/room", nil, 200)
		roomID = out["room"].(map[string]any)["id"].(string)
		for _, p := range out["participants"].([]any) {
			pm := p.(map[string]any)
			if pm["name"] == name {
				return roomID, pm["id"].(string)
			}
		}
		t.Fatalf("participant %q not found", name)
		return "", ""
	}
	roomID, bobID := pid(alice, "bob")

	// while bob is online, an invite code alone must not hijack him
	c := &testClient{t: t, base: srv.URL}
	c.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": secret, "name": "bob"}, 409)

	// offline bob is reclaimable: same id, fresh token, old token dead
	if err := store.GoOffline(context.Background(), roomID, bobID); err != nil {
		t.Fatal(err)
	}
	out := c.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": secret, "name": "bob"}, 200)
	if out["reclaimed"] != true {
		t.Fatalf("want reclaimed=true, got %v", out)
	}
	if got := out["participant"].(map[string]any)["id"].(string); got != bobID {
		t.Fatalf("reclaim changed identity: got %s want %s", got, bobID)
	}
	bob2 := &testClient{t: t, base: srv.URL, token: out["token"].(string)}
	bob2.must("GET", "/api/v1/me", nil, 200)
	if status, _ := bob.do("GET", "/api/v1/me", nil); status != 401 {
		t.Fatalf("old token still works after reclaim: %d", status)
	}

	// a revoked identity stays locked out even when offline
	alice.must("DELETE", "/api/v1/participants/"+bobID, nil, 200)
	c.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": secret, "name": "bob"}, 409)
}

func TestOwnership(t *testing.T) {
	srv, _ := newTestServer(t)

	c := &testClient{t: t, base: srv.URL}
	out := c.must("POST", "/api/v1/rooms", map[string]any{"name": "owned room"}, 201)
	roomCode := out["invite_code"].(string)

	join := func(code, name string, human bool) (*testClient, map[string]any) {
		cc := &testClient{t: t, base: srv.URL}
		out := cc.must("POST", "/api/v1/rooms/join", map[string]any{
			"invite_code": code, "name": name, "is_human": human,
		}, 201)
		cc.token = out["token"].(string)
		return cc, out["participant"].(map[string]any)
	}

	maya, mayaP := join(roomCode, "maya", true)
	if mayaP["owner_id"] != nil {
		t.Fatalf("room-code joiner has an owner: %v", mayaP)
	}

	// agent joined via maya's invite is owned by maya, server-verified
	inv := maya.must("POST", "/api/v1/invites", nil, 201)
	agent1, a1 := join(inv["invite_code"].(string), "helper", false)
	if a1["owner_id"] != mayaP["id"] {
		t.Fatalf("want owner %v, got %v", mayaP["id"], a1["owner_id"])
	}

	// ownership chains through an agent-issued invite to the human principal
	inv2 := agent1.must("POST", "/api/v1/invites", nil, 201)
	_, a2 := join(inv2["invite_code"].(string), "subhelper", false)
	if a2["owner_id"] != mayaP["id"] {
		t.Fatalf("chained owner: want %v, got %v", mayaP["id"], a2["owner_id"])
	}

	// humans never get an owner, whatever code they use
	_, h2 := join(inv["invite_code"].(string), "visitor", true)
	if h2["owner_id"] != nil {
		t.Fatalf("human got an owner: %v", h2)
	}

	// owner_name is exposed to everyone in the room
	list := maya.must("GET", "/api/v1/room", nil, 200)
	byName := map[string]map[string]any{}
	for _, p := range list["participants"].([]any) {
		pm := p.(map[string]any)
		byName[pm["name"].(string)] = pm
	}
	if byName["helper"]["owner_name"] != "maya" || byName["subhelper"]["owner_name"] != "maya" {
		t.Fatalf("owner_name missing: %v %v", byName["helper"], byName["subhelper"])
	}

	// a bad code still 404s
	cc := &testClient{t: t, base: srv.URL}
	cc.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": "inv-nope-nope-nope-nope", "name": "nobody"}, 404)
}

func TestReplyBarData(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, bob := setupRoom(t, srv.URL)

	root := alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "root"}, 201)
	rootID := root["id"].(string)
	aliceID := root["author_id"].(string)
	reply := func(c *testClient, body string) map[string]any {
		return c.must("POST", "/api/v1/channels/general/messages",
			map[string]any{"body": body, "thread_root_id": rootID}, 201)
	}
	reply(alice, "r1")
	bobMsg := reply(bob, "r2")
	bobID := bobMsg["author_id"].(string)
	last := reply(alice, "r3") // alice replies again: most recent replier

	out := alice.must("GET", "/api/v1/channels/general/messages", nil, 200)
	msgs := out["messages"].([]any)
	var m map[string]any
	for _, raw := range msgs {
		if mm := raw.(map[string]any); mm["id"] == rootID {
			m = mm
		}
	}
	if m == nil {
		t.Fatal("root message not in channel list")
	}
	if m["reply_count"].(float64) != 3 {
		t.Fatalf("reply_count: %v", m["reply_count"])
	}
	if m["last_reply_at"] != last["created_at"] {
		t.Fatalf("last_reply_at %v, want %v", m["last_reply_at"], last["created_at"])
	}
	ids := m["replier_ids"].([]any)
	// distinct repliers, most recent first: alice (r3) then bob (r2)
	if len(ids) != 2 || ids[0] != aliceID || ids[1] != bobID {
		t.Fatalf("replier_ids: %v (alice=%s bob=%s)", ids, aliceID, bobID)
	}

	// a message with no replies exposes an empty list and no timestamp
	solo := alice.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "solo"}, 201)
	if _, ok := solo["last_reply_at"]; ok {
		t.Fatalf("solo message has last_reply_at: %v", solo["last_reply_at"])
	}
	if len(solo["replier_ids"].([]any)) != 0 {
		t.Fatalf("solo replier_ids: %v", solo["replier_ids"])
	}
}

// TestInviteDiesOnRotate locks in that rotating the room secret kills every
// outstanding owner-scoped invite. Without it a kicked member walks back in on
// a code they minted and saved, and eviction never sticks.
func TestInviteDiesOnRotate(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, bob := setupRoom(t, srv.URL)

	// a member mints an owner-scoped invite (the legit "invite my agent" flow)
	code := bob.must("POST", "/api/v1/invites", nil, 201)["invite_code"].(string)

	// valid before rotation
	pre := &testClient{t: t, base: srv.URL}
	pre.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": code, "name": "preagent"}, 201)

	// admin rotates to evict
	out := alice.must("POST", "/api/v1/room/rotate-secret", nil, 200)
	newSecret := out["invite_code"].(string)

	// the saved owner-scoped code is now dead
	post := &testClient{t: t, base: srv.URL}
	post.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": code, "name": "postagent"}, 404)

	// the freshly rotated room code still works
	post.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": newSecret, "name": "postagent"}, 201)
}

// TestInviteDiesOnRevoke locks in that revoking a member kills the invites that
// member issued, so a kicked member cannot walk an agent back in on their code.
func TestInviteDiesOnRevoke(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, bob := setupRoom(t, srv.URL)

	bobID := ""
	for _, p := range alice.must("GET", "/api/v1/room", nil, 200)["participants"].([]any) {
		pm := p.(map[string]any)
		if pm["name"] == "bob" {
			bobID = pm["id"].(string)
		}
	}
	if bobID == "" {
		t.Fatal("bob not found")
	}

	code := bob.must("POST", "/api/v1/invites", nil, 201)["invite_code"].(string)

	alice.must("DELETE", "/api/v1/participants/"+bobID, nil, 200)

	c := &testClient{t: t, base: srv.URL}
	c.must("POST", "/api/v1/rooms/join", map[string]any{"invite_code": code, "name": "ghost"}, 404)
}

// TestReclaimRebindsOwner locks in that a reclaim binds ownership to the
// principal of the code actually used, in both directions: reclaim via an
// owner-scoped code takes on that owner; reclaim via the room code clears it.
// Without the rebind a reclaim silently keeps the stale owner.
func TestReclaimRebindsOwner(t *testing.T) {
	srv, store := newTestServer(t)

	c := &testClient{t: t, base: srv.URL}
	roomCode := c.must("POST", "/api/v1/rooms", map[string]any{"name": "owned"}, 201)["invite_code"].(string)

	join := func(code, name string, human bool, want int) (*testClient, map[string]any) {
		cc := &testClient{t: t, base: srv.URL}
		out := cc.must("POST", "/api/v1/rooms/join", map[string]any{
			"invite_code": code, "name": name, "is_human": human,
		}, want)
		if tok, ok := out["token"].(string); ok {
			cc.token = tok
		}
		return cc, out["participant"].(map[string]any)
	}

	maya, mayaP := join(roomCode, "maya", true, 201)
	mayaID := mayaP["id"].(string)
	mayaCode := maya.must("POST", "/api/v1/invites", nil, 201)["invite_code"].(string)

	// helper first joins on the room code: no owner
	_, helperP := join(roomCode, "helper", false, 201)
	if helperP["owner_id"] != nil {
		t.Fatalf("room-code agent has owner: %v", helperP)
	}
	helperID := helperP["id"].(string)
	roomID := maya.must("GET", "/api/v1/room", nil, 200)["room"].(map[string]any)["id"].(string)

	// offline, then reclaimed via maya's owner-scoped code: ownership binds to maya
	if err := store.GoOffline(context.Background(), roomID, helperID); err != nil {
		t.Fatal(err)
	}
	_, reclaimed := join(mayaCode, "helper", false, 200)
	if reclaimed["owner_id"] != mayaID {
		t.Fatalf("reclaim did not rebind owner: got %v want %v", reclaimed["owner_id"], mayaID)
	}

	// offline again, reclaimed via the room code: ownership clears
	if err := store.GoOffline(context.Background(), roomID, helperID); err != nil {
		t.Fatal(err)
	}
	_, recleared := join(roomCode, "helper", false, 200)
	if recleared["owner_id"] != nil {
		t.Fatalf("room-code reclaim left an owner: %v", recleared["owner_id"])
	}
}

// TestArchiveEmitsEvent guards the archive/unarchive event emission after
// folding the UPDATE and the event into one transaction, so an archive can
// never land without its event (and the toggle stays observable to clients).
func TestArchiveEmitsEvent(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, _ := setupRoom(t, srv.URL)

	ch := alice.must("POST", "/api/v1/channels", map[string]any{"name": "attic", "topic": "stuff"}, 201)
	chID := ch["id"].(string)

	hasEvent := func(after int64, typ string) bool {
		ev := alice.must("GET", fmt.Sprintf("/api/v1/events?after=%d", after), nil, 200)
		for _, e := range ev["events"].([]any) {
			em := e.(map[string]any)
			if em["type"] == typ && em["payload"].(map[string]any)["channel_id"] == chID {
				return true
			}
		}
		return false
	}

	c0 := int64(alice.must("GET", "/api/v1/events", nil, 200)["cursor"].(float64))
	alice.must("PATCH", "/api/v1/channels/"+chID, map[string]any{"archived": true}, 200)
	if !hasEvent(c0, "channel.archived") {
		t.Fatal("archive did not emit channel.archived")
	}

	c1 := int64(alice.must("GET", "/api/v1/events", nil, 200)["cursor"].(float64))
	alice.must("PATCH", "/api/v1/channels/"+chID, map[string]any{"archived": false}, 200)
	if !hasEvent(c1, "channel.unarchived") {
		t.Fatal("unarchive did not emit channel.unarchived")
	}
}

// TestReclaimDropsToMember locks in that a reclaim never inherits role. An admin
// who goes offline can otherwise be impersonated into admin: a member who knows
// the name reclaims it via the room code and rides in with the old role. The
// reclaimed identity must land as a plain member.
func TestReclaimDropsToMember(t *testing.T) {
	srv, store := newTestServer(t)

	c := &testClient{t: t, base: srv.URL}
	roomCode := c.must("POST", "/api/v1/rooms", map[string]any{"name": "takeover"}, 201)["invite_code"].(string)

	join := func(code, name string, want int) (*testClient, map[string]any) {
		cc := &testClient{t: t, base: srv.URL}
		out := cc.must("POST", "/api/v1/rooms/join", map[string]any{
			"invite_code": code, "name": name, "is_human": false,
		}, want)
		if tok, ok := out["token"].(string); ok {
			cc.token = tok
		}
		return cc, out["participant"].(map[string]any)
	}

	// first joiner is admin
	admin, adminP := join(roomCode, "boss", 201)
	if adminP["role"] != "admin" {
		t.Fatalf("first joiner not admin: %v", adminP)
	}
	adminID := adminP["id"].(string)
	roomID := admin.must("GET", "/api/v1/room", nil, 200)["room"].(map[string]any)["id"].(string)

	// admin goes offline; reclaiming the name via the room code rebinds the same
	// identity but must NOT carry the admin role over
	if err := store.GoOffline(context.Background(), roomID, adminID); err != nil {
		t.Fatal(err)
	}
	_, reclaimed := join(roomCode, "boss", 200)
	if reclaimed["id"] != adminID {
		t.Fatalf("reclaim rebound a different identity: %v", reclaimed)
	}
	if reclaimed["role"] != "member" {
		t.Fatalf("reclaim inherited role %v, want member (insider takeover path)", reclaimed["role"])
	}
}

// TestArchivedChannelReadOnly locks in that an archived channel is fully
// read-only: not just new posts, but edits and deletes of existing messages are
// rejected too. Unarchiving restores write access.
func TestArchivedChannelReadOnly(t *testing.T) {
	srv, _ := newTestServer(t)
	_, alice, _ := setupRoom(t, srv.URL)

	chID := alice.must("POST", "/api/v1/channels", map[string]any{"name": "vault"}, 201)["id"].(string)
	msgID := alice.must("POST", "/api/v1/channels/"+chID+"/messages", map[string]any{"body": "before archive"}, 201)["id"].(string)

	alice.must("PATCH", "/api/v1/channels/"+chID, map[string]any{"archived": true}, 200)

	// posts, edits, and deletes all rejected while archived
	alice.must("POST", "/api/v1/channels/"+chID+"/messages", map[string]any{"body": "after"}, 409)
	alice.must("PATCH", "/api/v1/messages/"+msgID, map[string]any{"body": "edited"}, 409)
	alice.must("DELETE", "/api/v1/messages/"+msgID, nil, 409)

	// unarchive restores write access; the message is editable and deletable again
	alice.must("PATCH", "/api/v1/channels/"+chID, map[string]any{"archived": false}, 200)
	alice.must("PATCH", "/api/v1/messages/"+msgID, map[string]any{"body": "edited now"}, 200)
	alice.must("DELETE", "/api/v1/messages/"+msgID, nil, 200)
}

func TestSkillDoc(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/skill")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET /skill: got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/markdown") {
		t.Fatalf("content-type = %q", ct)
	}
	raw, _ := io.ReadAll(resp.Body)
	doc := string(raw)

	// {{SERVER}} is substituted with the configured public URL, no literal placeholder left
	if strings.Contains(doc, "{{SERVER}}") {
		t.Fatal("skill doc still contains an unsubstituted {{SERVER}} placeholder")
	}
	if !strings.Contains(doc, "http://public.test") {
		t.Fatal("skill doc did not substitute the public URL")
	}

	// the close-the-loop and channel-monitoring guidance and their load-bearing rules are present
	for _, want := range []string{
		"## Close the loop on your work",
		"NOTABLE",
		"never post a\nheartbeat for an unchanged status",
		"terminal state",
		"merged — loop closed",
		"Watch the channels you own",
		"take the firehose",
		"poll your channels by unread",
		"unread_count",
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("skill doc missing %q", want)
		}
	}
}
