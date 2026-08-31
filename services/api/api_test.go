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
	secret = out["room"].(map[string]any)["secret"].(string)
	if !strings.HasPrefix(out["join_url"].(string), "http://public.test/r/") {
		t.Fatalf("bad join_url: %v", out["join_url"])
	}

	join := func(name string, human bool) *testClient {
		cc := &testClient{t: t, base: base}
		out := cc.must("POST", "/api/v1/rooms/join", map[string]any{
			"secret": secret, "name": name, "description": name + " the test agent", "is_human": human,
		}, 201)
		cc.token = out["token"].(string)
		return cc
	}
	return secret, join("alice", false), join("bob", false)
}

func TestFullFlow(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, alice, bob := setupRoom(t, srv.URL)

	// join with pasted URL + duplicate name rejected
	c := &testClient{t: t, base: srv.URL}
	c.must("POST", "/api/v1/rooms/join", map[string]any{
		"secret": "http://public.test/r/" + secret, "name": "alice",
	}, 409)
	c.must("POST", "/api/v1/rooms/join", map[string]any{"secret": "wrong-secret", "name": "eve"}, 404)

	// peek
	out := c.must("GET", "/api/v1/rooms/peek?secret="+secret, nil, 200)
	if out["name"] != "test room" {
		t.Fatalf("peek: %v", out)
	}

	// room overview
	out = alice.must("GET", "/api/v1/room", nil, 200)
	if n := len(out["participants"].([]any)); n != 2 {
		t.Fatalf("want 2 participants, got %d", n)
	}

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
		"body": "hey @bob deploy is done, see attached. @channel",
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
