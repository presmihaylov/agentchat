package models

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func eventTypes(t *testing.T, s *Store, roomID string, after int64) []string {
	t.Helper()
	evs, err := s.ListEvents(context.Background(), roomID, after, 500)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, e := range evs {
		out = append(out, e.Type)
	}
	return out
}

func lastSeq(t *testing.T, s *Store, roomID string) int64 {
	t.Helper()
	evs, err := s.ListEvents(context.Background(), roomID, 0, 10000)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) == 0 {
		return 0
	}
	return evs[len(evs)-1].Seq
}

func TestExpirySetClearRevive(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	r := mkRoom(t, s)
	ch := generalChannel(t, s, r.ID)
	alice, _ := mkParticipant(t, s, r.ID, "alice")
	post := func() error {
		_, err := s.CreateMessage(ctx, CreateMessageParams{RoomID: r.ID, ChannelID: ch.ID, AuthorID: alice.ID, Body: "hi"})
		return err
	}

	if r.ExpiresAt != nil || r.Expired || r.PurgeAt != nil {
		t.Fatalf("fresh room has expiry fields set: %+v", r)
	}
	future := time.Now().Add(time.Hour)
	r2, err := s.SetRoomExpiry(ctx, r.ID, &future, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r2.ExpiresAt == nil || r2.Expired || r2.PurgeAt == nil || !r2.PurgeAt.Equal(r2.ExpiresAt.Add(ExpiryGrace)) {
		t.Fatalf("future expiry: %+v", r2)
	}
	if err := post(); err != nil {
		t.Fatalf("posting before expiry: %v", err)
	}

	past := time.Now().Add(-time.Minute)
	r3, err := s.SetRoomExpiry(ctx, r.ID, &past, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !r3.Expired {
		t.Fatalf("past expiry not derived: %+v", r3)
	}
	if err := post(); !errors.Is(err, ErrRoomExpired) {
		t.Fatalf("posting in an expired room: got %v", err)
	}
	if expired, _ := s.RoomExpired(ctx, r.ID); !expired {
		t.Fatal("RoomExpired false on an expired room")
	}
	// the system lines still land (the sweeper and the expiry line need them)
	got, err := s.RoomByID(ctx, r.ID)
	if err != nil || !got.Expired {
		t.Fatalf("RoomByID after expiry: %+v %v", got, err)
	}

	// revive by extending, then clear
	r4, err := s.SetRoomExpiry(ctx, r.ID, &future, alice.ID)
	if err != nil || r4.Expired {
		t.Fatalf("revive: %+v %v", r4, err)
	}
	if err := post(); err != nil {
		t.Fatalf("posting after revive: %v", err)
	}
	r5, err := s.SetRoomExpiry(ctx, r.ID, nil, alice.ID)
	if err != nil || r5.ExpiresAt != nil || r5.PurgeAt != nil {
		t.Fatalf("clear: %+v %v", r5, err)
	}
	types := eventTypes(t, s, r.ID, 0)
	n := 0
	for _, ty := range types {
		if ty == "room.expiry_changed" {
			n++
		}
	}
	if n != 4 {
		t.Fatalf("want 4 room.expiry_changed events, got %d in %v", n, types)
	}
	msgs, err := s.ListChannelMessages(ctx, r.ID, ch.ID, nil, nil, nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, m := range msgs {
		if m.Kind == "system" {
			lines = append(lines, m.Body)
		}
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "set the workspace to expire on") || !strings.Contains(joined, "removed the workspace expiry") {
		t.Fatalf("missing #general expiry lines: %q", joined)
	}
}

func TestChannelExpiry(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	r := mkRoom(t, s)
	general := generalChannel(t, s, r.ID)
	alice, _ := mkParticipant(t, s, r.ID, "alice")
	past := time.Now().Add(-time.Minute)
	ch, err := s.CreateChannel(ctx, r.ID, "ttl", "", alice.ID, false, &past)
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Expired || ch.ExpiresAt == nil {
		t.Fatalf("created expired: %+v", ch)
	}
	_, err = s.CreateMessage(ctx, CreateMessageParams{RoomID: r.ID, ChannelID: ch.ID, AuthorID: alice.ID, Body: "x"})
	if !errors.Is(err, ErrChannelExpired) {
		t.Fatalf("post in expired channel: %v", err)
	}
	// the rest of the workspace is untouched
	if _, err := s.CreateMessage(ctx, CreateMessageParams{RoomID: r.ID, ChannelID: general.ID, AuthorID: alice.ID, Body: "x"}); err != nil {
		t.Fatalf("post in general: %v", err)
	}
	// general never takes an expiry
	if _, err := s.SetChannelExpiry(ctx, r.ID, general.ID, &past, alice.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("general expiry: %v", err)
	}
	// revive; edits work again
	future := time.Now().Add(time.Hour)
	ch2, err := s.SetChannelExpiry(ctx, r.ID, ch.ID, &future, alice.ID)
	if err != nil || ch2.Expired {
		t.Fatalf("revive: %+v %v", ch2, err)
	}
	m, err := s.CreateMessage(ctx, CreateMessageParams{RoomID: r.ID, ChannelID: ch.ID, AuthorID: alice.ID, Body: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetChannelExpiry(ctx, r.ID, ch.ID, &past, alice.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMessageBody(ctx, r.ID, m.ID, "y"); !errors.Is(err, ErrChannelExpired) {
		t.Fatalf("edit in expired channel: %v", err)
	}
	listed, err := s.ListChannels(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range listed {
		if c.ID == ch.ID && !c.Expired {
			t.Fatalf("ListChannels lost the expired flag: %+v", c)
		}
	}
}

type recordedExport struct {
	rooms, channels []string
	begins          int
	fail, failBegin bool
	onRoomExport    func(Room) // runs before the room export returns (tests a revive mid-export)
}

func (x *recordedExport) hooks() ExpiryHooks {
	return ExpiryHooks{
		BeginPurge: func(context.Context) error {
			x.begins++
			if x.failBegin {
				return errors.New("pg_dump failed")
			}
			return nil
		},
		ExportRoom: func(_ context.Context, r Room, data []byte) error {
			if x.fail {
				return errors.New("disk full")
			}
			if x.onRoomExport != nil {
				x.onRoomExport(r)
			}
			x.rooms = append(x.rooms, string(data))
			return nil
		},
		ExportChannel: func(_ context.Context, r Room, c Channel, data []byte) error {
			if x.fail {
				return errors.New("disk full")
			}
			x.channels = append(x.channels, string(data))
			return nil
		},
	}
}

func TestSweepExpiry(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	r := mkRoom(t, s)
	general := generalChannel(t, s, r.ID)
	alice, _ := mkParticipant(t, s, r.ID, "alice")
	att, err := s.CreateAttachment(ctx, r.ID, alice.ID, "n.txt", "text/plain", []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMessage(ctx, CreateMessageParams{RoomID: r.ID, ChannelID: general.ID, AuthorID: alice.ID, Body: "keep me", AttachmentIDs: []string{att.ID}}); err != nil {
		t.Fatal(err)
	}
	soon := time.Now().Add(-time.Second)
	ch, err := s.CreateChannel(ctx, r.ID, "short", "", alice.ID, false, &soon)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRoomExpiry(ctx, r.ID, &soon, alice.ID); err != nil {
		t.Fatal(err)
	}
	before := lastSeq(t, s, r.ID)

	// 1. flip: one announcement each, none on the second sweep
	rec := &recordedExport{}
	flipped, purged, err := s.SweepExpiry(ctx, rec.hooks())
	if err != nil || flipped < 2 || purged != 0 {
		t.Fatalf("first sweep: flipped=%d purged=%d err=%v", flipped, purged, err)
	}
	types := eventTypes(t, s, r.ID, before)
	if strings.Join(types, ",") != "room.expired,channel.expired" {
		t.Fatalf("flip events: %v", types)
	}
	flipped, purged, err = s.SweepExpiry(ctx, rec.hooks())
	if err != nil || flipped != 0 || purged != 0 || rec.begins != 0 {
		t.Fatalf("second sweep: flipped=%d purged=%d begins=%d err=%v", flipped, purged, rec.begins, err)
	}

	// 2. the channel ages past the grace: exported and deleted, the room stays
	if _, err := s.pool.Exec(ctx, `UPDATE channels SET expires_at = now() - $2::interval WHERE id = $1`, ch.ID, (ExpiryGrace + time.Minute).String()); err != nil {
		t.Fatal(err)
	}
	rec.fail = true
	if _, purged, err = s.SweepExpiry(ctx, rec.hooks()); err != nil || purged != 0 {
		t.Fatalf("failing export must keep the channel: purged=%d err=%v", purged, err)
	}
	if _, err := s.ChannelByID(ctx, r.ID, ch.ID); err != nil {
		t.Fatalf("channel deleted despite a failed export: %v", err)
	}
	rec.fail = false
	if _, purged, err = s.SweepExpiry(ctx, rec.hooks()); err != nil || purged != 1 || len(rec.channels) != 1 || rec.begins < 1 {
		t.Fatalf("channel purge: purged=%d exports=%d begins=%d err=%v", purged, len(rec.channels), rec.begins, err)
	}
	if _, err := s.ChannelByID(ctx, r.ID, ch.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("channel still there after purge: %v", err)
	}
	var chExport map[string]any
	if err := json.Unmarshal([]byte(rec.channels[0]), &chExport); err != nil {
		t.Fatal(err)
	}
	if chExport["format"] != "agentchat-channel-export" || chExport["channel"].(map[string]any)["name"] != "short" {
		t.Fatalf("channel export: %v", chExport)
	}
	if _, err := s.RoomByID(ctx, r.ID); err != nil {
		t.Fatalf("room purged with its channel: %v", err)
	}

	// 3. the room ages past the grace
	if _, err := s.pool.Exec(ctx, `UPDATE rooms SET expires_at = now() - $2::interval WHERE id = $1`, r.ID, (ExpiryGrace + time.Minute).String()); err != nil {
		t.Fatal(err)
	}
	// 3a. a failing pre-purge dump keeps every row
	rec.failBegin = true
	if _, purged, err = s.SweepExpiry(ctx, rec.hooks()); err == nil || purged != 0 {
		t.Fatalf("failing BeginPurge must skip the purge: purged=%d err=%v", purged, err)
	}
	if _, err := s.RoomByID(ctx, r.ID); err != nil {
		t.Fatalf("room deleted despite a failed BeginPurge: %v", err)
	}
	rec.failBegin = false
	// 3b. an admin who extends the expiry while the export runs wins
	rec.onRoomExport = func(rm Room) {
		later := time.Now().Add(time.Hour)
		if _, err := s.SetRoomExpiry(ctx, rm.ID, &later, alice.ID); err != nil {
			t.Error(err)
		}
	}
	if _, purged, err = s.SweepExpiry(ctx, rec.hooks()); err != nil || purged != 0 {
		t.Fatalf("revive during export must keep the room: purged=%d err=%v", purged, err)
	}
	if _, err := s.RoomByID(ctx, r.ID); err != nil {
		t.Fatalf("room deleted despite a revive: %v", err)
	}
	rec.onRoomExport = nil
	rec.rooms = nil
	if _, err := s.pool.Exec(ctx, `UPDATE rooms SET expires_at = now() - $2::interval WHERE id = $1`, r.ID, (ExpiryGrace + time.Minute).String()); err != nil {
		t.Fatal(err)
	}
	// 3c. exported (no secrets) and deleted
	if _, purged, err = s.SweepExpiry(ctx, rec.hooks()); err != nil || purged != 1 || len(rec.rooms) != 1 {
		t.Fatalf("room purge: purged=%d exports=%d err=%v", purged, len(rec.rooms), err)
	}
	if _, err := s.RoomByID(ctx, r.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("room still there after purge: %v", err)
	}
	raw := rec.rooms[0]
	var export map[string]any
	if err := json.Unmarshal([]byte(raw), &export); err != nil {
		t.Fatal(err)
	}
	if export["format"] != "agentchat-workspace-export" {
		t.Fatalf("format: %v", export["format"])
	}
	if strings.Contains(raw, r.Secret) || strings.Contains(raw, "token_hash") || strings.Contains(raw, `"secret"`) {
		t.Fatal("export carries a secret")
	}
	if len(export["messages"].([]any)) < 1 || len(export["participants"].([]any)) != 1 || len(export["events"].([]any)) < 3 {
		t.Fatalf("export is missing rows: %v", export)
	}
	atts := export["attachments"].([]any)
	if len(atts) != 1 || atts[0].(map[string]any)["data_base64"] != "cGF5bG9hZA==" {
		t.Fatalf("attachment export: %v", atts)
	}
	if !strings.Contains(raw, "keep me") {
		t.Fatal("export lost the message body")
	}
}
