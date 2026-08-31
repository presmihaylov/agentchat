package models

import (
	"context"
	"encoding/json"
)

func (s *Store) CreateRoom(ctx context.Context, name, secret string) (Room, error) {
	var r Room
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx,
		`INSERT INTO rooms (name, secret) VALUES ($1, $2)
		 RETURNING id, secret, name, created_at`,
		name, secret,
	).Scan(&r.ID, &r.Secret, &r.Name, &r.CreatedAt)
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

func (s *Store) RoomBySecret(ctx context.Context, secret string) (Room, error) {
	var r Room
	err := s.pool.QueryRow(ctx,
		`SELECT id, secret, name, created_at FROM rooms WHERE secret = $1`, secret,
	).Scan(&r.ID, &r.Secret, &r.Name, &r.CreatedAt)
	return r, mapRowErr(err)
}

// RotateSecret replaces the room's join secret, invalidating the old link.
func (s *Store) RotateSecret(ctx context.Context, roomID, newSecret string) (Room, error) {
	var r Room
	err := s.pool.QueryRow(ctx,
		`UPDATE rooms SET secret = $2 WHERE id = $1
		 RETURNING id, secret, name, created_at`,
		roomID, newSecret,
	).Scan(&r.ID, &r.Secret, &r.Name, &r.CreatedAt)
	if err != nil {
		return r, mapRowErr(err)
	}
	// never put the secret itself in the event log
	return r, s.AppendEvent(ctx, roomID, "room.secret_rotated", map[string]string{"room_id": roomID})
}

func (s *Store) RenameRoom(ctx context.Context, roomID, name string) (Room, error) {
	var r Room
	err := s.pool.QueryRow(ctx,
		`UPDATE rooms SET name = $2 WHERE id = $1
		 RETURNING id, secret, name, created_at`,
		roomID, name,
	).Scan(&r.ID, &r.Secret, &r.Name, &r.CreatedAt)
	if err != nil {
		return r, mapRowErr(err)
	}
	return r, s.AppendEvent(ctx, roomID, "room.renamed", map[string]string{"room_id": roomID, "name": name})
}

func (s *Store) RoomByID(ctx context.Context, id string) (Room, error) {
	var r Room
	err := s.pool.QueryRow(ctx,
		`SELECT id, secret, name, created_at FROM rooms WHERE id = $1`, id,
	).Scan(&r.ID, &r.Secret, &r.Name, &r.CreatedAt)
	return r, mapRowErr(err)
}
