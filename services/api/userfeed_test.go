package api

import (
	"fmt"
	"testing"
)

// feedEvents polls the user feed with the given cursors (slug -> seq) and no
// wait; the client c must hold a session. Returns the events and the cursors.
func feedEvents(t *testing.T, c *testClient, cursors map[string]int64) ([]map[string]any, map[string]int64) {
	t.Helper()
	q := ""
	for slug, seq := range cursors {
		if q != "" {
			q += ","
		}
		q += fmt.Sprintf("%s:%d", slug, seq)
	}
	out := c.must("GET", "/api/v1/user/events?cursors="+q, nil, 200)
	events := []map[string]any{}
	for _, e := range out["events"].([]any) {
		events = append(events, e.(map[string]any))
	}
	got := map[string]int64{}
	for slug, seq := range out["cursors"].(map[string]any) {
		got[slug] = int64(seq.(float64))
	}
	return events, got
}

// TestUserEventsFeed: one long-poll feeds every member workspace (task 23),
// tagged by slug, gated like the per-workspace feed, and blind to rooms the
// account is not in.
func TestUserEventsFeed(t *testing.T) {
	srv, _ := newTestServer(t)
	creator, _, alpha := sessionRoom(t, srv.URL, "alpha")
	alphaSlug := alpha["slug"].(string)
	betaOut := creator.must("POST", "/api/v1/rooms", roomBody("beta"), 201)
	betaSlug := betaOut["room"].(map[string]any)["slug"].(string)
	_, _, other := sessionRoom(t, srv.URL, "other")
	otherSlug := other["slug"].(string)

	// no cursors: every member room answers with its latest seq and no events
	feed := &testClient{t: t, base: srv.URL, token: creator.token}
	events, cursors := feedEvents(t, feed, nil)
	if len(events) != 0 || len(cursors) != 2 {
		t.Fatalf("cold feed: %v %v", events, cursors)
	}
	if _, ok := cursors[otherSlug]; ok {
		t.Fatal("a room the account is not in leaked into the feed")
	}
	if cursors[alphaSlug] == 0 || cursors[betaSlug] == 0 {
		t.Fatalf("cold cursors must be the latest seqs: %v", cursors)
	}

	// a message in beta comes back tagged beta; alpha's cursor stands still
	creator.slug = betaSlug
	creator.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "in beta"}, 201)
	events, next := feedEvents(t, feed, cursors)
	if len(events) != 1 || events[0]["type"] != "message.created" || events[0]["workspace"] != betaSlug {
		t.Fatalf("beta message: %v", events)
	}
	if next[alphaSlug] != cursors[alphaSlug] || next[betaSlug] <= cursors[betaSlug] {
		t.Fatalf("cursors after beta message: before %v after %v", cursors, next)
	}
	// a cursor for a room the account is not in is ignored, never scanned
	stale := map[string]int64{alphaSlug: next[alphaSlug], betaSlug: next[betaSlug], otherSlug: 0}
	events, next = feedEvents(t, feed, stale)
	if len(events) != 0 {
		t.Fatalf("foreign cursor: %v", events)
	}
	if _, ok := next[otherSlug]; ok {
		t.Fatal("foreign cursor echoed back")
	}
	// a cursor beyond the latest seq answers empty without moving backwards
	events, ahead := feedEvents(t, feed, map[string]int64{alphaSlug: next[alphaSlug] + 100, betaSlug: next[betaSlug]})
	if len(events) != 0 || ahead[alphaSlug] != next[alphaSlug]+100 {
		t.Fatalf("cursor ahead: %v %v", events, ahead)
	}

	// a member outside a private channel never sees its messages, in the
	// shared feed as in the per-workspace one; the cursor still moves past them
	member, _ := registerAs(t, srv.URL, "Mia Member")
	member.slug = alphaSlug
	member.must("POST", "/api/v1/workspaces/"+alphaSlug+"/enter", map[string]any{"invite": alpha["invite"]}, 200)
	memberFeed := &testClient{t: t, base: srv.URL, token: member.token}
	_, mc := feedEvents(t, memberFeed, nil)
	if len(mc) != 1 {
		t.Fatalf("member rooms: %v", mc)
	}
	creator.slug = alphaSlug
	creator.must("POST", "/api/v1/channels", map[string]any{"name": "secret", "private": true}, 201)
	creator.must("POST", "/api/v1/channels/secret/messages", map[string]any{"body": "hush"}, 201)
	creator.must("POST", "/api/v1/channels/general/messages", map[string]any{"body": "for all"}, 201)
	events, mc2 := feedEvents(t, memberFeed, mc)
	bodies := []string{}
	for _, e := range events {
		if e["type"] == "message.created" {
			bodies = append(bodies, e["payload"].(map[string]any)["body"].(string))
		}
	}
	if len(bodies) != 1 || bodies[0] != "for all" {
		t.Fatalf("private channel leaked into the feed: %v", bodies)
	}
	if mc2[alphaSlug] <= mc[alphaSlug] {
		t.Fatalf("member cursor did not move: %v -> %v", mc, mc2)
	}

	// bad input and the wrong credential
	if st, _ := feed.do("GET", "/api/v1/user/events?cursors=nonsense", nil); st != 400 {
		t.Fatalf("bad cursors: %d", st)
	}
	_, alice, _ := setupRoom(t, srv.URL)
	if st, out := alice.do("GET", "/api/v1/user/events", nil); st != 401 || out["code"] != "session_required" {
		t.Fatalf("act_ token on the user feed: %d %v", st, out)
	}
}
