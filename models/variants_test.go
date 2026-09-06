package models

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"testing"
)

// TestBackfillAvatarVariants: an avatar uploaded before variants existed gets
// its 128 and 512px copies from the one-off job; the original is untouched,
// a non-resizable upload is marked and not retried.
func TestBackfillAvatarVariants(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	room := mkRoom(t, s)
	admin, _ := mkParticipant(t, s, room.ID, "admin")

	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 900, 900)))
	big, err := s.CreateAttachment(ctx, room.ID, admin.ID, "logo.png", "image/png", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	bogus, err := s.CreateAttachment(ctx, room.ID, admin.ID, "x.png", "image/png", []byte("not an image"))
	if err != nil {
		t.Fatal(err)
	}
	unused, err := s.CreateAttachment(ctx, room.ID, admin.ID, "unused.png", "image/png", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetRoomAvatar(ctx, room.ID, &big.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetAvatarAttachment(ctx, room.ID, admin.ID, &bogus.ID); err != nil {
		t.Fatal(err)
	}

	// before: the small size falls back to the original bytes
	a, err := s.AttachmentSized(ctx, room.ID, big.ID, VariantSmall)
	if err != nil || len(a.Data) != buf.Len() {
		t.Fatalf("before backfill: %d bytes %v", len(a.Data), err)
	}

	// the dev db is shared: other tests' avatars ride the same run, so the
	// counts are lower bounds and the checks below are on our own rows
	done, skipped, err := s.BackfillAvatarVariants(ctx)
	if err != nil || done < 1 || skipped < 1 {
		t.Fatalf("backfill: done %d skipped %d %v", done, skipped, err)
	}
	small, err := s.AttachmentSized(ctx, room.ID, big.ID, VariantSmall)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(small.Data))
	if err != nil || cfg.Width != 128 || small.ContentType != "image/png" || len(small.Data) >= buf.Len() {
		t.Fatalf("small variant: %+v %d bytes %s %v", cfg, len(small.Data), small.ContentType, err)
	}
	large, _ := s.AttachmentSized(ctx, room.ID, big.ID, VariantLarge)
	if cfg, _, _ := image.DecodeConfig(bytes.NewReader(large.Data)); cfg.Width != 512 {
		t.Fatalf("large variant: %+v", cfg)
	}
	orig, _ := s.AttachmentByID(ctx, room.ID, big.ID)
	if len(orig.Data) != buf.Len() {
		t.Fatalf("original changed: %d", len(orig.Data))
	}
	// the bogus one still serves its bytes, and an unreferenced upload is left alone
	if b, _ := s.AttachmentSized(ctx, room.ID, bogus.ID, VariantSmall); string(b.Data) != "not an image" {
		t.Fatalf("bogus fallback: %q", b.Data)
	}
	if u, _ := s.AttachmentSized(ctx, room.ID, unused.ID, VariantSmall); len(u.Data) != buf.Len() {
		t.Fatalf("unused upload was resized")
	}
	if done, skipped, _ := s.BackfillAvatarVariants(ctx); done != 0 || skipped != 0 {
		t.Fatalf("second run not idempotent: %d %d", done, skipped)
	}
}
