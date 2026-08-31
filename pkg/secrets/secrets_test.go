package secrets

import (
	"regexp"
	"strings"
	"testing"
)

func TestRoomSlugShape(t *testing.T) {
	re := regexp.MustCompile(`^([a-z]+-){2}[0-9abcdefghjkmnpqrstvwxyz]{4}$`)
	seen := map[string]bool{}
	for range 100 {
		s := RoomSlug()
		if !re.MatchString(s) {
			t.Fatalf("bad slug shape: %q", s)
		}
		if seen[s] {
			t.Fatalf("duplicate slug: %q", s)
		}
		seen[s] = true
	}
}

func TestInviteCodeShape(t *testing.T) {
	re := regexp.MustCompile(`^inv(-[0-9abcdefghjkmnpqrstvwxyz]{4}){4}$`)
	seen := map[string]bool{}
	for range 100 {
		s := InviteCode()
		if !re.MatchString(s) {
			t.Fatalf("bad invite code shape: %q", s)
		}
		if seen[s] {
			t.Fatalf("duplicate invite code: %q", s)
		}
		seen[s] = true
	}
}

func TestWordlistLoaded(t *testing.T) {
	if len(words) != 7776 {
		t.Fatalf("expected 7776 words, got %d", len(words))
	}
}

func TestNewToken(t *testing.T) {
	token, hash := NewToken()
	if !strings.HasPrefix(token, "act_") || len(token) != 4+32 {
		t.Fatalf("bad token: %q", token)
	}
	if len(hash) != 32 {
		t.Fatalf("bad hash length: %d", len(hash))
	}
	if string(HashToken(token)) != string(hash) {
		t.Fatal("HashToken mismatch")
	}
}
