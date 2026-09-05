package models

import (
	"context"
	"testing"
)

// The orphan GC must skip an upload that a room uses as its avatar, the same
// way it skips participant avatars; a plain old orphan still goes.
func TestOrphanGCKeepsRoomAvatar(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	r := mkRoom(t, s)
	alice, _ := mkParticipant(t, s, r.ID, "alice")
	png := []byte("\x89PNG\r\n\x1a\nfake")
	logo, err := s.CreateAttachment(ctx, r.ID, alice.ID, "logo.png", "image/png", png)
	if err != nil {
		t.Fatal(err)
	}
	orphan, err := s.CreateAttachment(ctx, r.ID, alice.ID, "stray.png", "image/png", png)
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.SetRoomAvatar(ctx, r.ID, &logo.ID)
	if err != nil {
		t.Fatal(err)
	}
	if room.AvatarAttachmentID == nil || *room.AvatarAttachmentID != logo.ID || room.AvatarURL != "/api/v1/attachments/"+logo.ID {
		t.Fatalf("avatar not set: %+v", room)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id IN ($1, $2)`, logo.ID, orphan.ID); err != nil {
		t.Fatal(err)
	}
	n, err := s.DeleteOrphanAttachments(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("GC deleted %d rows, want the one stray", n)
	}
	var kept int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE id = $1`, logo.ID).Scan(&kept); err != nil || kept != 1 {
		t.Fatalf("room avatar attachment gone: kept=%d err=%v", kept, err)
	}
	// clearing the avatar makes the upload an orphan again
	if _, err := s.SetRoomAvatar(ctx, r.ID, nil); err != nil {
		t.Fatal(err)
	}
	if n, err := s.DeleteOrphanAttachments(ctx); err != nil || n != 1 {
		t.Fatalf("GC after remove: n=%d err=%v", n, err)
	}
}
