package models

import (
	"context"
	"encoding/json"
)

func (s *Store) CreateRoom(ctx context.Context, name, slug, secret string) (Room, error) {
	var r Room
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx,
		`INSERT INTO rooms (name, slug, secret) VALUES ($1, $2, $3)
		 RETURNING id, slug, secret, name, created_at`,
		name, slug, secret,
	).Scan(&r.ID, &r.Slug, &r.Secret, &r.Name, &r.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return r, ErrConflict
		}
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

// RoomBySecret looks a room up by its invite code.
func (s *Store) RoomBySecret(ctx context.Context, secret string) (Room, error) {
	var r Room
	err := s.pool.QueryRow(ctx,
		`SELECT id, slug, secret, name, created_at FROM rooms WHERE secret = $1`, secret,
	).Scan(&r.ID, &r.Slug, &r.Secret, &r.Name, &r.CreatedAt)
	return r, mapRowErr(err)
}

// RoomBySlug looks a room up by its public URL slug.
func (s *Store) RoomBySlug(ctx context.Context, slug string) (Room, error) {
	var r Room
	err := s.pool.QueryRow(ctx,
		`SELECT id, slug, secret, name, created_at FROM rooms WHERE slug = $1`, slug,
	).Scan(&r.ID, &r.Slug, &r.Secret, &r.Name, &r.CreatedAt)
	return r, mapRowErr(err)
}

// RotateSecret replaces the room's invite code, invalidating the old one.
// The public slug (and so the room URL) stays stable.
func (s *Store) RotateSecret(ctx context.Context, roomID, newSecret string) (Room, error) {
	var r Room
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)

	// advisory lock BEFORE the rooms-row lock: every event-appending tx locks
	// advisory-first, so taking the row lock first here would be an AB-BA
	// deadlock against e.g. a concurrent join (FK FOR KEY SHARE on rooms)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return r, err
	}
	err = tx.QueryRow(ctx,
		`UPDATE rooms SET secret = $2 WHERE id = $1
		 RETURNING id, slug, secret, name, created_at`,
		roomID, newSecret,
	).Scan(&r.ID, &r.Slug, &r.Secret, &r.Name, &r.CreatedAt)
	if err != nil {
		return r, mapRowErr(err)
	}
	// rotation is an eviction lever: kill every outstanding owner-scoped invite
	// too, else a kicked member re-enters with a code they minted and saved
	if _, err := tx.Exec(ctx, `DELETE FROM invites WHERE room_id = $1`, roomID); err != nil {
		return r, err
	}
	// never put the secret itself in the event log
	payload, _ := json.Marshal(map[string]string{"room_id": roomID})
	if err := appendEventTx(ctx, tx, roomID, "room.secret_rotated", payload); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}

func (s *Store) RenameRoom(ctx context.Context, roomID, name string) (Room, error) {
	var r Room
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)

	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return r, err
	}
	err = tx.QueryRow(ctx,
		`UPDATE rooms SET name = $2 WHERE id = $1
		 RETURNING id, slug, secret, name, created_at`,
		roomID, name,
	).Scan(&r.ID, &r.Slug, &r.Secret, &r.Name, &r.CreatedAt)
	if err != nil {
		return r, mapRowErr(err)
	}
	payload, _ := json.Marshal(map[string]string{"room_id": roomID, "name": name})
	if err := appendEventTx(ctx, tx, roomID, "room.renamed", payload); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}

func (s *Store) RoomByID(ctx context.Context, id string) (Room, error) {
	var r Room
	err := s.pool.QueryRow(ctx,
		`SELECT id, slug, secret, name, created_at FROM rooms WHERE id = $1`, id,
	).Scan(&r.ID, &r.Slug, &r.Secret, &r.Name, &r.CreatedAt)
	return r, mapRowErr(err)
}
