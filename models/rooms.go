package models

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

const roomColumns = `id, slug, name, created_by_user_id, created_at, avatar_attachment_id, color, delivery_dead_letter_days, delivery_max_attempts`

// roomColumnsOf is roomColumns qualified with a table alias, for joins.
func roomColumnsOf(alias string) string {
	return alias + "." + strings.ReplaceAll(roomColumns, ", ", ", "+alias+".")
}

// roomDest pairs roomColumns for Scan.
func roomDest(r *Room) []any {
	return []any{&r.ID, &r.Slug, &r.Name, &r.CreatedByUserID, &r.CreatedAt, &r.AvatarAttachmentID, &r.Color, &r.DeliveryDeadLetterDays, &r.DeliveryMaxAttempts}
}

// scanRoom fills r from a roomColumns row and derives the avatar URL.
func scanRoom(row pgx.Row, r *Room) error {
	if err := row.Scan(roomDest(r)...); err != nil {
		return err
	}
	r.AvatarURL = AvatarPath(r.AvatarAttachmentID)
	return nil
}

// RoomQuota is how many rooms one user may create.
const RoomQuota = 5

var ErrRoomQuota = errors.New("you already created the maximum number of workspaces")

// ErrInviteInvalid: the code does not open the workspace it was presented to.
var ErrInviteInvalid = errors.New("that invite code does not open this workspace")

// CreateRoom makes an agent-only room (tests, legacy fixtures) with one plain
// invite link carrying token.
func (s *Store) CreateRoom(ctx context.Context, name, slug, token string) (Room, error) {
	var r Room
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)

	err = scanRoom(tx.QueryRow(ctx,
		`INSERT INTO rooms (name, slug, color) VALUES ($1, $2, floor(random() * $3))
		 RETURNING `+roomColumns,
		name, slug, RoomColorSlots,
	), &r)
	if err != nil {
		if isUniqueViolation(err) {
			return r, ErrConflict
		}
		return r, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO invites (token, room_id) VALUES ($1, $2)`, token, r.ID); err != nil {
		return r, err
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO channels (room_id, name, topic) VALUES ($1, 'general', 'General discussion')`,
		r.ID)
	if err != nil {
		return r, err
	}

	payload, _ := json.Marshal(map[string]string{"room_id": r.ID, "name": r.Name})
	if err := appendEventTx(ctx, tx, r.ID, "room.created", payload); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}

// RoomBySlug looks a room up by its public URL slug.
func (s *Store) RoomBySlug(ctx context.Context, slug string) (Room, error) {
	var r Room
	err := scanRoom(s.pool.QueryRow(ctx,
		`SELECT `+roomColumns+` FROM rooms WHERE slug = $1`, slug,
	), &r)
	return r, mapRowErr(err)
}

// RenameRoom renames the workspace and, when the name actually changed, writes
// "renamed the workspace from X to Y" into #general as the actor.
func (s *Store) RenameRoom(ctx context.Context, roomID, name, actorID string) (Room, error) {
	var r Room
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)

	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return r, err
	}
	var old string
	if err := tx.QueryRow(ctx, `SELECT name FROM rooms WHERE id = $1 FOR UPDATE`, roomID).Scan(&old); err != nil {
		return r, mapRowErr(err)
	}
	err = scanRoom(tx.QueryRow(ctx,
		`UPDATE rooms SET name = $2 WHERE id = $1
		 RETURNING `+roomColumns,
		roomID, name,
	), &r)
	if err != nil {
		return r, mapRowErr(err)
	}
	payload, _ := json.Marshal(map[string]string{"room_id": roomID, "name": name})
	if err := appendEventTx(ctx, tx, roomID, "room.renamed", payload); err != nil {
		return r, err
	}
	if old != name {
		if err := generalEntryTx(ctx, tx, roomID, actorID, "renamed the workspace from "+old+" to "+name); err != nil {
			return r, err
		}
	}
	return r, tx.Commit(ctx)
}

// DeleteRoom removes the room and, through the cascades, every participant
// (so each agent token dies), channel, message and attachment row; uploads
// live in the attachments table, so nothing is left on disk. The room lock
// goes first so no event writer is mid-transaction on the way out.
func (s *Store) DeleteRoom(ctx context.Context, roomID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return err
	}
	res, err := tx.Exec(ctx, `DELETE FROM rooms WHERE id = $1`, roomID)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (s *Store) RoomByID(ctx context.Context, id string) (Room, error) {
	var r Room
	err := scanRoom(s.pool.QueryRow(ctx,
		`SELECT `+roomColumns+` FROM rooms WHERE id = $1`, id,
	), &r)
	return r, mapRowErr(err)
}

// SetRoomAvatar points the workspace image at an upload, or clears it (nil)
// so the initials come back.
func (s *Store) SetRoomAvatar(ctx context.Context, roomID string, attachmentID *string) (Room, error) {
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
		`UPDATE rooms SET avatar_attachment_id = $2 WHERE id = $1
		 RETURNING `+roomColumns,
		roomID, attachmentID,
	), &r)
	if err != nil {
		return r, mapRowErr(err)
	}
	payload, _ := json.Marshal(map[string]string{"room_id": roomID})
	if err := appendEventTx(ctx, tx, roomID, "room.updated", payload); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}
