package models

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

var objSchema = json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}`)

func jsonEq(raw json.RawMessage, want string) bool {
	var a, b any
	if json.Unmarshal(raw, &a) != nil || json.Unmarshal([]byte(want), &b) != nil {
		return false
	}
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func capInputs(names ...string) []CapabilityInput {
	out := []CapabilityInput{}
	for _, n := range names {
		out = append(out, CapabilityInput{Name: n, Description: "does " + n, InputSchema: objSchema})
	}
	return out
}

// TestCapabilityRegistry (task 27): upsert keeps the rest, replace drops the
// rest, delete removes one, the per-agent quota holds, and the room list
// hides offline agents unless asked.
func TestCapabilityRegistry(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	room := mkRoom(t, s)
	a, _ := mkParticipant(t, s, room.ID, "alpha")
	b, _ := mkParticipant(t, s, room.ID, "beta")

	got, err := s.UpsertCapabilities(ctx, room.ID, a.ID, capInputs("search", "summarize"), false)
	if err != nil || len(got) != 2 {
		t.Fatalf("register: %v %d", err, len(got))
	}
	// upsert by name: search changes, summarize stays, fetch is new
	caps := capInputs("search", "fetch")
	caps[0].Description = "searches better"
	got, err = s.UpsertCapabilities(ctx, room.ID, a.ID, caps, false)
	if err != nil || len(got) != 3 {
		t.Fatalf("upsert: %v %d", err, len(got))
	}
	for _, c := range got {
		if c.Name == "search" && c.Description != "searches better" {
			t.Fatalf("upsert did not update: %v", c)
		}
	}
	// replace: only what is sent survives
	got, err = s.UpsertCapabilities(ctx, room.ID, a.ID, capInputs("fetch"), true)
	if err != nil || len(got) != 1 || got[0].Name != "fetch" {
		t.Fatalf("replace: %v %v", err, got)
	}
	if err := s.DeleteCapability(ctx, room.ID, a.ID, "fetch"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := s.DeleteCapability(ctx, room.ID, a.ID, "fetch"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete want ErrNotFound, got %v", err)
	}
	// quota: 50 fit, 51 do not
	many := []string{}
	for i := 0; i < CapabilityMaxPerAgent+1; i++ {
		many = append(many, fmt.Sprintf("cap_%d", i))
	}
	if _, err := s.UpsertCapabilities(ctx, room.ID, a.ID, capInputs(many...), true); !errors.Is(err, ErrCapabilityQuota) {
		t.Fatalf("quota want ErrCapabilityQuota, got %v", err)
	}
	if _, err := s.UpsertCapabilities(ctx, room.ID, a.ID, capInputs(many[:CapabilityMaxPerAgent]...), true); err != nil {
		t.Fatalf("50 capabilities: %v", err)
	}
	// the change events carry the names, never a schema
	evs, err := s.ListEvents(ctx, room.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	reg := 0
	for _, e := range evs {
		if e.Type == "capability.registered" {
			reg++
		}
	}
	if reg < 5 {
		t.Fatalf("want a capability.registered per change, got %d", reg)
	}

	// room list: beta registered but is offline (last_seen_at old)
	if _, err := s.UpsertCapabilities(ctx, room.ID, b.ID, capInputs("draw"), true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE participants SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.TouchPresence(ctx, room.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	online, err := s.ListRoomCapabilities(ctx, room.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range online {
		if c.ParticipantID == b.ID {
			t.Fatalf("offline agent listed as callable: %v", c)
		}
	}
	all, err := s.ListRoomCapabilities(ctx, room.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != len(online)+1 {
		t.Fatalf("all=%d online=%d", len(all), len(online))
	}
}

// TestCapabilityCalls (task 27): the call path in the store: online check,
// self-call, result by the target only, once only, the pending cap, the
// timeout flip by the sweep, cross-room isolation, and the prune.
func TestCapabilityCalls(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	room := mkRoom(t, s)
	caller, _ := mkParticipant(t, s, room.ID, "caller")
	target, _ := mkParticipant(t, s, room.ID, "target")
	other, _ := mkParticipant(t, s, room.ID, "other")
	if _, err := s.UpsertCapabilities(ctx, room.ID, target.ID, capInputs("echo"), true); err != nil {
		t.Fatal(err)
	}
	params := func(timeout int) CreateCallParams {
		return CreateCallParams{RoomID: room.ID, CallerID: caller.ID, TargetID: target.ID, Name: "echo", Args: json.RawMessage(`{"q":"hi"}`), TimeoutSecs: timeout}
	}

	if _, err := s.CreateCall(ctx, CreateCallParams{RoomID: room.ID, CallerID: target.ID, TargetID: target.ID, Name: "echo", Args: json.RawMessage(`{}`), TimeoutSecs: 5}); !errors.Is(err, ErrSelfCall) {
		t.Fatalf("self call: %v", err)
	}
	if _, err := s.CreateCall(ctx, CreateCallParams{RoomID: room.ID, CallerID: caller.ID, TargetID: target.ID, Name: "nope", Args: json.RawMessage(`{}`), TimeoutSecs: 5}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown capability: %v", err)
	}

	// happy path
	c, err := s.CreateCall(ctx, params(30))
	if err != nil || c.State != CallPending || c.TargetName != "target" || c.CallerName != "caller" {
		t.Fatalf("create: %v %+v", err, c)
	}
	if _, err := s.FinishCall(ctx, room.ID, c.ID, other.ID, json.RawMessage(`{"ok":true}`), nil); !errors.Is(err, ErrNotTarget) {
		t.Fatalf("non-target answer: %v", err)
	}
	done, err := s.FinishCall(ctx, room.ID, c.ID, target.ID, json.RawMessage(`{"ok":true}`), nil)
	if err != nil || done.State != CallDone || !jsonEq(done.Result, `{"ok":true}`) || done.FinishedAt == nil {
		t.Fatalf("finish: %v %+v", err, done)
	}
	if _, err := s.FinishCall(ctx, room.ID, c.ID, target.ID, json.RawMessage(`{}`), nil); !errors.Is(err, ErrCallFinished) {
		t.Fatalf("second answer: %v", err)
	}
	// WaitCall returns a finished call at once
	if w, err := s.WaitCall(ctx, room.ID, c.ID, 10*time.Millisecond); err != nil || w.State != CallDone {
		t.Fatalf("wait finished: %v %+v", err, w)
	}

	// error path
	c, err = s.CreateCall(ctx, params(30))
	if err != nil {
		t.Fatal(err)
	}
	msg := "boom"
	e, err := s.FinishCall(ctx, room.ID, c.ID, target.ID, json.RawMessage(`{"ignored":1}`), &msg)
	if err != nil || e.State != CallError || e.Error == nil || *e.Error != "boom" || len(e.Result) != 0 {
		t.Fatalf("error finish: %v %+v", err, e)
	}

	// the delivery receipt for the target rides with the call
	var receipts int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM deliveries WHERE recipient_id = $1 AND state = 'accepted'`, target.ID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 2 {
		t.Fatalf("want 2 accepted receipts for the target, got %d", receipts)
	}

	// timeout flip: a 1 s call, then the sweep; a late answer is refused
	c, err = s.CreateCall(ctx, params(1))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(1100 * time.Millisecond)
	if err := s.SweepCalls(ctx); err != nil {
		t.Fatal(err)
	}
	if g, err := s.GetCall(ctx, room.ID, c.ID); err != nil || g.State != CallTimeout {
		t.Fatalf("sweep did not flip: %v %+v", err, g)
	}
	if _, err := s.FinishCall(ctx, room.ID, c.ID, target.ID, json.RawMessage(`{}`), nil); !errors.Is(err, ErrCallFinished) {
		t.Fatalf("late answer: %v", err)
	}
	// WaitCall flips an overdue call itself
	c, err = s.CreateCall(ctx, params(1))
	if err != nil {
		t.Fatal(err)
	}
	if w, err := s.WaitCall(ctx, room.ID, c.ID, 50*time.Millisecond); err != nil || w.State != CallTimeout {
		t.Fatalf("wait timeout: %v %+v", err, w)
	}

	// pending cap: 8 open calls, the 9th is refused
	for i := 0; i < CapabilityMaxPending; i++ {
		if _, err := s.CreateCall(ctx, params(60)); err != nil {
			t.Fatalf("pending %d: %v", i, err)
		}
	}
	if _, err := s.CreateCall(ctx, params(60)); !errors.Is(err, ErrTooManyCalls) {
		t.Fatalf("9th pending: %v", err)
	}

	// offline target
	if _, err := s.pool.Exec(ctx, `UPDATE participants SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, target.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateCall(ctx, params(5)); !errors.Is(err, ErrAgentOffline) {
		t.Fatalf("offline target: %v", err)
	}
	if err := s.TouchPresence(ctx, room.ID, target.ID); err != nil {
		t.Fatal(err)
	}

	// cross-room: a caller of room B cannot reach target by id, and B's call
	// row is invisible from A
	roomB := mkRoom(t, s)
	outsider, _ := mkParticipant(t, s, roomB.ID, "outsider")
	if _, err := s.CreateCall(ctx, CreateCallParams{RoomID: roomB.ID, CallerID: outsider.ID, TargetID: target.ID, Name: "echo", Args: json.RawMessage(`{}`), TimeoutSecs: 5}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-room call: %v", err)
	}
	if _, err := s.GetCall(ctx, roomB.ID, c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-room get: %v", err)
	}
	if _, err := s.FinishCall(ctx, roomB.ID, c.ID, target.ID, json.RawMessage(`{}`), nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-room finish: %v", err)
	}

	// prune: a finished call older than the keep window goes away
	if _, err := s.pool.Exec(ctx, `UPDATE capability_calls SET finished_at = now() - interval '8 days' WHERE id = $1`, done.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SweepCalls(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetCall(ctx, room.ID, done.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("prune: %v", err)
	}
}
