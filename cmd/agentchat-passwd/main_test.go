package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/pkg/secrets"
)

func TestReadPasswordFromStdin(t *testing.T) {
	got, err := readPassword(strings.NewReader("battery staple\n"), false)
	if err != nil || got != "battery staple" {
		t.Fatalf("piped: %q %v", got, err)
	}
	got, err = readPassword(strings.NewReader("no newline"), false)
	if err != nil || got != "no newline" {
		t.Fatalf("eof: %q %v", got, err)
	}
	if _, err := readPassword(strings.NewReader("\n"), false); err == nil {
		t.Fatal("empty password accepted")
	}
}

func TestRunUsage(t *testing.T) {
	if err := run([]string{"alice", "hunter22"}); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("password in argv must be refused: %v", err)
	}
}

// DB-backed: reset writes a working hash and logs the user out everywhere.
func TestReset(t *testing.T) {
	url := os.Getenv("AGENTCHAT_DB_URL")
	if url == "" {
		t.Skip("AGENTCHAT_DB_URL not set")
	}
	ctx := context.Background()
	store, err := models.Open(ctx, url)
	if err != nil {
		t.Skipf("db unavailable: %v", err)
	}
	defer store.Close()

	name := fmt.Sprintf("pw%d", time.Now().UnixNano()%1_000_000_000_000)
	oldHash, err := bcrypt.GenerateFromPassword([]byte("old horse"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	u, err := store.CreatePasswordUser(ctx, name, name, oldHash)
	if err != nil {
		t.Fatal(err)
	}
	var hashes [][]byte
	for range 2 {
		_, h := secrets.NewSessionToken()
		if _, err := store.CreateSession(ctx, u.ID, "password", h, time.Hour); err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, h)
	}

	n, err := reset(ctx, store, name, "new horse")
	if err != nil || n != 2 {
		t.Fatalf("reset: %d %v", n, err)
	}
	for _, h := range hashes {
		if _, _, err := store.SessionByTokenHash(ctx, h, time.Hour); !errors.Is(err, models.ErrNotFound) {
			t.Fatalf("session survived the reset: %v", err)
		}
	}
	_, hash, err := store.PasswordIdentity(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	if bcrypt.CompareHashAndPassword(hash, []byte("new horse")) != nil {
		t.Fatal("new password rejected")
	}
	if bcrypt.CompareHashAndPassword(hash, []byte("old horse")) == nil {
		t.Fatal("old password still accepted")
	}
	if _, err := reset(ctx, store, "nobody-"+name, "new horse"); err == nil || !strings.Contains(err.Error(), "no password account") {
		t.Fatalf("unknown user: %v", err)
	}
}
