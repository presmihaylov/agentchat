package models

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ExpiryGrace is how long an expired workspace or channel stays readable
// before the sweeper exports and deletes it.
const ExpiryGrace = 7 * 24 * time.Hour

var (
	ErrRoomExpired    = errors.New("this workspace expired and is read-only")
	ErrChannelExpired = errors.New("this channel expired and is read-only")
)

// SQL for "expired right now", evaluated in the same statement as the write
// guard so a concurrent extension cannot race past it.
const (
	roomExpiredSQL    = `(r.expires_at IS NOT NULL AND r.expires_at <= now())`
	channelExpiredSQL = `(c.expires_at IS NOT NULL AND c.expires_at <= now())`
)

func (r *Room) deriveExpiry() {
	r.Expired, r.PurgeAt = false, nil
	if r.ExpiresAt == nil {
		return
	}
	r.Expired = !r.ExpiresAt.After(time.Now())
	purge := r.ExpiresAt.Add(ExpiryGrace)
	r.PurgeAt = &purge
}

func (c *Channel) deriveExpiry() {
	c.Expired = c.ExpiresAt != nil && !c.ExpiresAt.After(time.Now())
}

// writableErr orders the read-only reasons: a dead workspace outranks a
// dead channel, which outranks an archive.
func writableErr(archived, channelExpired, roomExpired bool) error {
	if roomExpired {
		return ErrRoomExpired
	}
	if channelExpired {
		return ErrChannelExpired
	}
	if archived {
		return ErrArchived
	}
	return nil
}

// RoomExpired is the cheap per-request check behind the API's write gate.
func (s *Store) RoomExpired(ctx context.Context, roomID string) (bool, error) {
	var expired bool
	err := s.pool.QueryRow(ctx, `SELECT `+roomExpiredSQL+` FROM rooms r WHERE r.id = $1`, roomID).Scan(&expired)
	return expired, mapRowErr(err)
}

func expiryPayload(at *time.Time) any {
	if at == nil {
		return nil
	}
	return at.UTC().Format(time.RFC3339)
}

func expiryLine(what string, at *time.Time) string {
	if at == nil {
		return "removed the " + what + " expiry"
	}
	return "set the " + what + " to expire on " + at.UTC().Format("2006-01-02 15:04 UTC")
}

// SetRoomExpiry sets (or clears, with nil) when the workspace turns read-only.
// A future time on an expired workspace revives it: the sweeper's expired_at
// mark is cleared so the next expiry is announced again.
func (s *Store) SetRoomExpiry(ctx context.Context, roomID string, at *time.Time, actorID string) (Room, error) {
	var r Room
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return r, err
	}
	err = scanRoom(tx.QueryRow(ctx,
		`UPDATE rooms SET expires_at = $2,
		   expired_at = CASE WHEN $2::timestamptz IS NULL OR $2::timestamptz > now() THEN NULL ELSE expired_at END
		 WHERE id = $1 RETURNING `+roomColumns,
		roomID, at), &r)
	if err != nil {
		return r, mapRowErr(err)
	}
	payload, _ := json.Marshal(map[string]any{"room_id": roomID, "expires_at": expiryPayload(at)})
	if err := appendEventTx(ctx, tx, roomID, "room.expiry_changed", payload); err != nil {
		return r, err
	}
	if err := generalEntryTx(ctx, tx, roomID, actorID, expiryLine("workspace", at)); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}

// SetChannelExpiry is SetRoomExpiry for one channel. The general channel
// never expires on its own; callers reject it before getting here.
func (s *Store) SetChannelExpiry(ctx context.Context, roomID, channelID string, at *time.Time, actorID string) (Channel, error) {
	var c Channel
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return c, err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return c, err
	}
	err = tx.QueryRow(ctx,
		`UPDATE channels SET expires_at = $3,
		   expired_at = CASE WHEN $3::timestamptz IS NULL OR $3::timestamptz > now() THEN NULL ELSE expired_at END
		 WHERE room_id = $1 AND id = $2 AND name <> 'general'
		 RETURNING id, room_id, name, topic, created_by, archived, private, created_at, expires_at`,
		roomID, channelID, at,
	).Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.Private, &c.CreatedAt, &c.ExpiresAt)
	if err != nil {
		return c, mapRowErr(err)
	}
	c.deriveExpiry()
	payload, _ := json.Marshal(map[string]any{"channel_id": channelID, "expires_at": expiryPayload(at)})
	if err := appendEventTx(ctx, tx, roomID, "channel.expiry_changed", payload); err != nil {
		return c, err
	}
	if err := systemEntryTx(ctx, tx, roomID, channelID, actorID, expiryLine("channel", at)); err != nil {
		return c, err
	}
	return c, tx.Commit(ctx)
}

// ExpiryHooks run before the sweeper deletes anything. BeginPurge runs once
// per sweep that has something to purge (a database dump, say). ExportRoom
// and ExportChannel receive the JSON export of the doomed thing. Any error
// keeps the rows: nothing is deleted without its export on disk.
type ExpiryHooks struct {
	BeginPurge    func(ctx context.Context) error
	ExportRoom    func(ctx context.Context, r Room, data []byte) error
	ExportChannel func(ctx context.Context, r Room, c Channel, data []byte) error
}

// SweepExpiry announces every workspace and channel whose expires_at just
// passed (room.expired / channel.expired, once each), then exports and deletes
// the ones past ExpiryGrace. Returns how many it flipped and purged; a failed
// export is logged and skipped, the sweep goes on.
func (s *Store) SweepExpiry(ctx context.Context, hooks ExpiryHooks) (flipped, purged int, err error) {
	n, err := s.flipExpiredRooms(ctx)
	if err != nil {
		return flipped, purged, err
	}
	flipped += n
	n, err = s.flipExpiredChannels(ctx)
	if err != nil {
		return flipped, purged, err
	}
	flipped += n

	rooms, err := s.roomsToPurge(ctx)
	if err != nil {
		return flipped, purged, err
	}
	channels, err := s.channelsToPurge(ctx)
	if err != nil {
		return flipped, purged, err
	}
	if len(rooms)+len(channels) == 0 {
		return flipped, purged, nil
	}
	if hooks.BeginPurge != nil {
		if err := hooks.BeginPurge(ctx); err != nil {
			return flipped, purged, fmt.Errorf("expiry purge skipped: %w", err)
		}
	}
	for _, r := range rooms {
		if err := s.purgeRoom(ctx, r, hooks); err != nil {
			logKept(err, "expiry: workspace kept", "slug", r.Slug)
			continue
		}
		purged++
	}
	for _, pc := range channels {
		if err := s.purgeChannel(ctx, pc.room, pc.channel, hooks); err != nil {
			logKept(err, "expiry: channel kept", "slug", pc.room.Slug, "channel", pc.channel.Name)
			continue
		}
		purged++
	}
	return flipped, purged, nil
}

func (s *Store) flipExpiredRooms(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM rooms WHERE expires_at <= now() AND expired_at IS NULL`)
	if err != nil {
		return 0, err
	}
	ids, err := scanStrings(rows)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		flipped, err := s.flipRoom(ctx, id)
		if err != nil {
			return n, err
		}
		if flipped {
			n++
		}
	}
	return n, nil
}

func (s *Store) flipRoom(ctx context.Context, roomID string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return false, err
	}
	// re-checked under the lock: an extension between the scan and here wins
	var r Room
	err = scanRoom(tx.QueryRow(ctx,
		`UPDATE rooms SET expired_at = now() WHERE id = $1 AND expires_at <= now() AND expired_at IS NULL
		 RETURNING `+roomColumns, roomID), &r)
	if errors.Is(mapRowErr(err), ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	payload, _ := json.Marshal(map[string]any{
		"room_id": roomID, "expires_at": expiryPayload(r.ExpiresAt), "purge_at": expiryPayload(r.PurgeAt),
	})
	if err := appendEventTx(ctx, tx, roomID, "room.expired", payload); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (s *Store) flipExpiredChannels(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, room_id FROM channels WHERE expires_at <= now() AND expired_at IS NULL`)
	if err != nil {
		return 0, err
	}
	type pair struct{ id, roomID string }
	var pairs []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.id, &p.roomID); err != nil {
			rows.Close()
			return 0, err
		}
		pairs = append(pairs, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	n := 0
	for _, p := range pairs {
		flipped, err := s.flipChannel(ctx, p.roomID, p.id)
		if err != nil {
			return n, err
		}
		if flipped {
			n++
		}
	}
	return n, nil
}

func (s *Store) flipChannel(ctx context.Context, roomID, channelID string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return false, err
	}
	var name string
	var at time.Time
	err = tx.QueryRow(ctx,
		`UPDATE channels SET expired_at = now()
		 WHERE room_id = $1 AND id = $2 AND expires_at <= now() AND expired_at IS NULL
		 RETURNING name, expires_at`, roomID, channelID).Scan(&name, &at)
	if errors.Is(mapRowErr(err), ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	purge := at.Add(ExpiryGrace)
	payload, _ := json.Marshal(map[string]any{
		"channel_id": channelID, "name": name, "expires_at": expiryPayload(&at), "purge_at": expiryPayload(&purge),
	})
	if err := appendEventTx(ctx, tx, roomID, "channel.expired", payload); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (s *Store) roomsToPurge(ctx context.Context) ([]Room, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+roomColumns+` FROM rooms WHERE expires_at + $1::interval <= now() ORDER BY expires_at`,
		ExpiryGrace.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Room
	for rows.Next() {
		var r Room
		if err := scanRoom(rows, &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type purgeChannel struct {
	room    Room
	channel Channel
}

// channelsToPurge skips channels whose whole workspace is on the way out.
func (s *Store) channelsToPurge(ctx context.Context) ([]purgeChannel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT c.id, c.room_id, c.name, c.topic, c.created_by, c.archived, c.private, c.created_at, c.expires_at,
		        `+roomColumnsAs("r")+`
		 FROM channels c JOIN rooms r ON r.id = c.room_id
		 WHERE c.expires_at + $1::interval <= now() AND c.name <> 'general'
		   AND (r.expires_at IS NULL OR r.expires_at + $1::interval > now())
		 ORDER BY c.expires_at`,
		ExpiryGrace.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []purgeChannel
	for rows.Next() {
		var pc purgeChannel
		c, r := &pc.channel, &pc.room
		dest := append([]any{&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.Private, &c.CreatedAt, &c.ExpiresAt}, roomDest(r)...)
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		c.deriveExpiry()
		r.deriveExpiry()
		out = append(out, pc)
	}
	return out, rows.Err()
}

func (s *Store) purgeRoom(ctx context.Context, r Room, hooks ExpiryHooks) error {
	if hooks.ExportRoom == nil {
		return errors.New("no export hook configured")
	}
	data, err := s.ExportRoom(ctx, r.ID)
	if err != nil {
		return fmt.Errorf("export: %w", err)
	}
	if err := hooks.ExportRoom(ctx, r, data); err != nil {
		return fmt.Errorf("export: %w", err)
	}
	return s.deletePurgeableRoom(ctx, r.ID)
}

// errRevived: an admin extended the expiry while the export ran; the row stays.
var errRevived = errors.New("revived during export, kept")

// deletePurgeableRoom re-checks the grace under the room lock, so a revive
// that landed while the export was running wins over the sweep.
func (s *Store) deletePurgeableRoom(ctx context.Context, roomID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return err
	}
	res, err := tx.Exec(ctx, `DELETE FROM rooms WHERE id = $1 AND expires_at + $2::interval <= now()`, roomID, ExpiryGrace.String())
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return errRevived
	}
	return tx.Commit(ctx)
}

func (s *Store) deletePurgeableChannel(ctx context.Context, roomID, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return err
	}
	res, err := tx.Exec(ctx,
		`DELETE FROM channels WHERE room_id = $1 AND id = $2 AND expires_at + $3::interval <= now()`, roomID, id, ExpiryGrace.String())
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return errRevived
	}
	payload, _ := json.Marshal(map[string]string{"channel_id": id})
	if err := appendEventTx(ctx, tx, roomID, "channel.deleted", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) purgeChannel(ctx context.Context, r Room, c Channel, hooks ExpiryHooks) error {
	if hooks.ExportChannel == nil {
		return errors.New("no export hook configured")
	}
	data, err := s.ExportChannel(ctx, r.ID, c.ID)
	if err != nil {
		return fmt.Errorf("export: %w", err)
	}
	if err := hooks.ExportChannel(ctx, r, c, data); err != nil {
		return fmt.Errorf("export: %w", err)
	}
	return s.deletePurgeableChannel(ctx, r.ID, c.ID)
}

// ExportRoom is the whole workspace as one JSON document: room (no invite
// code), participants (no token hashes), channels and their members,
// messages, reactions, mentions, attachments (base64) and the event log.
func (s *Store) ExportRoom(ctx context.Context, roomID string) ([]byte, error) {
	var out []byte
	err := s.pool.QueryRow(ctx, `
		SELECT jsonb_build_object(
		  'format', 'agentchat-workspace-export', 'version', 1, 'exported_at', now(),
		  'room', (SELECT to_jsonb(r) - 'secret' FROM rooms r WHERE r.id = $1),
		  'participants', (SELECT COALESCE(jsonb_agg(to_jsonb(p) - 'token_hash' ORDER BY p.created_at), '[]') FROM participants p WHERE p.room_id = $1),
		  'channels', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at), '[]') FROM channels c WHERE c.room_id = $1),
		  'channel_members', (SELECT COALESCE(jsonb_agg(to_jsonb(cm)), '[]') FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE c.room_id = $1),
		  'messages', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.created_at, m.id), '[]') FROM messages m WHERE m.room_id = $1),
		  'reactions', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') FROM message_reactions x JOIN messages m ON m.id = x.message_id WHERE m.room_id = $1),
		  'mentions', (SELECT COALESCE(jsonb_agg(to_jsonb(mn)), '[]') FROM mentions mn JOIN messages m ON m.id = mn.message_id WHERE m.room_id = $1),
		  'message_attachments', (SELECT COALESCE(jsonb_agg(to_jsonb(ma)), '[]') FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.room_id = $1),
		  'attachments', (SELECT COALESCE(jsonb_agg((to_jsonb(a) - 'data') || jsonb_build_object('data_base64', encode(a.data, 'base64')) ORDER BY a.created_at), '[]') FROM attachments a WHERE a.room_id = $1),
		  'events', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.seq), '[]') FROM events e WHERE e.room_id = $1)
		)::text`, roomID).Scan(&out)
	return out, mapRowErr(err)
}

// ExportChannel is one channel the same way: the channel, its members, its
// messages, their reactions and mentions, and the attachments they carry.
func (s *Store) ExportChannel(ctx context.Context, roomID, channelID string) ([]byte, error) {
	var out []byte
	err := s.pool.QueryRow(ctx, `
		SELECT jsonb_build_object(
		  'format', 'agentchat-channel-export', 'version', 1, 'exported_at', now(),
		  'room', (SELECT to_jsonb(r) - 'secret' FROM rooms r WHERE r.id = $1),
		  'channel', (SELECT to_jsonb(c) FROM channels c WHERE c.room_id = $1 AND c.id = $2),
		  'channel_members', (SELECT COALESCE(jsonb_agg(to_jsonb(cm)), '[]') FROM channel_members cm WHERE cm.channel_id = $2),
		  'messages', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.created_at, m.id), '[]') FROM messages m WHERE m.channel_id = $2),
		  'reactions', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') FROM message_reactions x JOIN messages m ON m.id = x.message_id WHERE m.channel_id = $2),
		  'mentions', (SELECT COALESCE(jsonb_agg(to_jsonb(mn)), '[]') FROM mentions mn JOIN messages m ON m.id = mn.message_id WHERE m.channel_id = $2),
		  'message_attachments', (SELECT COALESCE(jsonb_agg(to_jsonb(ma)), '[]') FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.channel_id = $2),
		  'attachments', (SELECT COALESCE(jsonb_agg((to_jsonb(a) - 'data') || jsonb_build_object('data_base64', encode(a.data, 'base64'))), '[]')
		                  FROM attachments a WHERE a.id IN (SELECT ma.attachment_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.channel_id = $2))
		)::text`, roomID, channelID).Scan(&out)
	return out, mapRowErr(err)
}

// roomColumnsAs prefixes roomColumns with a table alias for joined selects.
func roomColumnsAs(alias string) string {
	return alias + "." + strings.ReplaceAll(roomColumns, ", ", ", "+alias+".")
}

func scanStrings(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// assertNotExpiredTx fails a reaction (which archived channels still allow)
// when the message's channel or workspace has expired.
func assertNotExpiredTx(ctx context.Context, tx pgx.Tx, roomID, messageID string) error {
	var chExpired, roomExpired bool
	err := tx.QueryRow(ctx,
		`SELECT `+channelExpiredSQL+`, `+roomExpiredSQL+`
		 FROM messages m JOIN channels c ON c.id = m.channel_id JOIN rooms r ON r.id = c.room_id
		 WHERE m.id = $1 AND m.room_id = $2`, messageID, roomID).Scan(&chExpired, &roomExpired)
	if err != nil {
		return mapRowErr(err)
	}
	return writableErr(false, chExpired, roomExpired)
}

func logKept(err error, msg string, kv ...any) {
	kv = append(kv, "err", err)
	if errors.Is(err, errRevived) {
		slog.Info(msg, kv...)
		return
	}
	slog.Error(msg, kv...)
}
