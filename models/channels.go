package models

import (
	"context"
	"encoding/json"
)

func (s *Store) CreateChannel(ctx context.Context, roomID, name, topic, createdBy string) (Channel, error) {
	var c Channel
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return c, err
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx,
		`INSERT INTO channels (room_id, name, topic, created_by) VALUES ($1, $2, $3, $4)
		 RETURNING id, room_id, name, topic, created_by, archived, created_at`,
		roomID, name, topic, createdBy,
	).Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return c, ErrConflict
		}
		return c, err
	}

	payload, _ := json.Marshal(map[string]string{"channel_id": c.ID, "name": c.Name, "created_by": createdBy})
	if err := appendEventTx(ctx, tx, roomID, "channel.created", payload); err != nil {
		return c, err
	}
	return c, tx.Commit(ctx)
}

func (s *Store) ListChannels(ctx context.Context, roomID string) ([]Channel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, room_id, name, topic, created_by, archived, created_at
		 FROM channels WHERE room_id = $1 ORDER BY created_at ASC`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Channel{}
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ChannelByID(ctx context.Context, roomID, id string) (Channel, error) {
	var c Channel
	err := s.pool.QueryRow(ctx,
		`SELECT id, room_id, name, topic, created_by, archived, created_at
		 FROM channels WHERE room_id = $1 AND id = $2`, roomID, id,
	).Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.CreatedAt)
	return c, mapRowErr(err)
}

func (s *Store) ChannelByName(ctx context.Context, roomID, name string) (Channel, error) {
	var c Channel
	err := s.pool.QueryRow(ctx,
		`SELECT id, room_id, name, topic, created_by, archived, created_at
		 FROM channels WHERE room_id = $1 AND name = $2`, roomID, name,
	).Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.CreatedAt)
	return c, mapRowErr(err)
}

func (s *Store) SetChannelArchived(ctx context.Context, roomID, id string, archived bool) error {
	res, err := s.pool.Exec(ctx,
		`UPDATE channels SET archived = $3 WHERE room_id = $1 AND id = $2`, roomID, id, archived)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	typ := "channel.archived"
	if !archived {
		typ = "channel.unarchived"
	}
	return s.AppendEvent(ctx, roomID, typ, map[string]string{"channel_id": id})
}
