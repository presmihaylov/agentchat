package main

import (
	"compress/gzip"
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"

	"github.com/presmihaylov/agentchat/models"
)

// expiryHooks writes every doomed workspace or channel as gzipped JSON under
// dir and, when pg_dump is on PATH, takes one pg_dump -Fc of the whole
// database per sweep before the first purge. Any failure keeps the rows.
func expiryHooks(dir, dbURL string) models.ExpiryHooks {
	stamp := func() string { return time.Now().UTC().Format("20060102T150405Z") }
	// a purge that fails every tick must not fill the disk with dumps
	var lastDump time.Time
	return models.ExpiryHooks{
		BeginPurge: func(ctx context.Context) error {
			pgDump, err := exec.LookPath("pg_dump")
			if err != nil {
				slog.Warn("expiry: pg_dump not on PATH, purging with the JSON export only")
				return nil
			}
			if time.Since(lastDump) < dumpEvery {
				return nil
			}
			if err := os.MkdirAll(dir, 0o750); err != nil {
				return err
			}
			path := filepath.Join(dir, "predelete-"+stamp()+".dump")
			conn, password := splitPassword(dbURL)
			cmd := exec.CommandContext(ctx, pgDump, "-Fc", "-d", conn, "-f", path)
			cmd.Env = append(os.Environ(), "PGPASSWORD="+password)
			if out, err := cmd.CombinedOutput(); err != nil {
				return fmt.Errorf("pg_dump: %w: %s", err, out)
			}
			lastDump = time.Now()
			slog.Info("expiry: database dumped before purge", "path", path)
			return nil
		},
		ExportRoom: func(_ context.Context, r models.Room, data []byte) error {
			return writeExport(filepath.Join(dir, safeName(r.Slug)+"-"+stamp()+".json.gz"), data)
		},
		ExportChannel: func(_ context.Context, r models.Room, c models.Channel, data []byte) error {
			return writeExport(filepath.Join(dir, safeName(r.Slug)+"-"+safeName(c.Name)+"-"+stamp()+".json.gz"), data)
		},
	}
}

var unsafeName = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func safeName(s string) string {
	s = unsafeName.ReplaceAllString(s, "_")
	if s == "" {
		return "x"
	}
	return s
}

// writeExport gzips data to path through a temp file and a rename, and
// fsyncs, so a crash mid-write never leaves a truncated export in place.
func writeExport(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".export-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	zw := gzip.NewWriter(tmp)
	if _, err := zw.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	slog.Info("expiry: exported before purge", "path", path, "bytes", len(data))
	return nil
}

// dumpEvery bounds how often BeginPurge takes a pg_dump: one per hour, so a
// purge that keeps failing does not take one every minute.
const dumpEvery = time.Hour

// splitPassword keeps the db password out of the pg_dump argument list.
func splitPassword(dbURL string) (conn, password string) {
	u, err := url.Parse(dbURL)
	if err != nil || u.User == nil {
		return dbURL, ""
	}
	password, _ = u.User.Password()
	u.User = url.User(u.User.Username())
	return u.String(), password
}
