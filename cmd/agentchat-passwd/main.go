// Command agentchat-passwd resets a user's password from the server host:
//
//	agentchat-passwd <username>
//
// The new password is read from the terminal (hidden) or, when stdin is not a
// terminal, from the first line of stdin; it never appears in argv or ps. It
// writes a fresh bcrypt hash and logs the user out everywhere.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/services/auth"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "agentchat-passwd:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: agentchat-passwd <username>  (password read from stdin)")
	}
	username := strings.ToLower(strings.TrimSpace(args[0]))
	dbURL := os.Getenv("AGENTCHAT_DB_URL")
	if dbURL == "" {
		return errors.New("AGENTCHAT_DB_URL is required")
	}
	password, err := readPassword(os.Stdin, term.IsTerminal(int(os.Stdin.Fd())))
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, err := models.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer store.Close()

	n, err := reset(ctx, store, username, password)
	if err != nil {
		return err
	}
	fmt.Printf("password updated for %s; %d session(s) logged out\n", username, n)
	return nil
}

// readPassword prompts without echo on a terminal and otherwise takes one
// line from in, so scripts can pipe the password.
func readPassword(in io.Reader, isTerminal bool) (string, error) {
	var raw []byte
	var err error
	if isTerminal {
		fmt.Fprint(os.Stderr, "New password: ")
		raw, err = term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
	}
	if !isTerminal {
		raw, err = bufio.NewReader(in).ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			err = nil
		}
	}
	if err != nil {
		return "", err
	}
	password := strings.TrimRight(string(raw), "\r\n")
	if password == "" {
		return "", errors.New("password must not be empty")
	}
	return password, nil
}

// reset stores the new hash and revokes every session in one transaction.
func reset(ctx context.Context, store *models.Store, username, password string) (int64, error) {
	hash, err := auth.HashPassword(password)
	if err != nil {
		return 0, err
	}
	userID, _, err := store.PasswordIdentity(ctx, username)
	if errors.Is(err, models.ErrNotFound) {
		return 0, fmt.Errorf("no password account for %q", username)
	}
	if err != nil {
		return 0, err
	}
	return store.SetPasswordHash(ctx, userID, hash, nil)
}
