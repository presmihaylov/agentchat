package models

import (
	"context"
	"encoding/json"
	"time"
)

func (s *Store) CreateChannel(ctx context.Context, roomID, name, topic, createdBy string) (Channel, error) {
	var c Channel
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return c, err
	}
	defer tx.Rollback(ctx)

	// advisory-first: the insert takes FK row locks on rooms before appendEventTx
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return c, err
	}

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

// ListChannelsUnread is ListChannels plus the viewer's read state. Unread
// counts only top-level messages from others; the baseline for someone who
// never marked a channel read is their own join time, not the room's birth.
func (s *Store) ListChannelsUnread(ctx context.Context, roomID, participantID string) ([]Channel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT c.id, c.room_id, c.name, c.topic, c.created_by, c.archived, c.created_at,
		        r.last_read_at,
		        (SELECT count(*) FROM messages m
		         WHERE m.channel_id = c.id AND m.thread_root_id IS NULL
		           AND m.author_id <> $2
		           AND m.created_at > COALESCE(r.last_read_at, p.created_at)) AS unread
		 FROM channels c
		 JOIN participants p ON p.id = $2
		 LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.participant_id = $2
		 WHERE c.room_id = $1 ORDER BY c.created_at ASC`, roomID, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Channel{}
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived,
			&c.CreatedAt, &c.LastReadAt, &c.UnreadCount); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// MarkChannelRead advances the viewer's read marker to now and returns it.
func (s *Store) MarkChannelRead(ctx context.Context, participantID, channelID string) (time.Time, error) {
	var at time.Time
	err := s.pool.QueryRow(ctx,
		`INSERT INTO channel_reads (participant_id, channel_id, last_read_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (participant_id, channel_id) DO UPDATE SET last_read_at = now()
		 RETURNING last_read_at`, participantID, channelID).Scan(&at)
	return at, err
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

// DeleteChannel removes a channel and (via FK cascade) all its messages.
func (s *Store) DeleteChannel(ctx context.Context, roomID, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	res, err := tx.Exec(ctx,
		`DELETE FROM channels WHERE room_id = $1 AND id = $2`, roomID, id)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	payload, _ := json.Marshal(map[string]string{"channel_id": id})
	if err := appendEventTx(ctx, tx, roomID, "channel.deleted", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) SetChannelArchived(ctx context.Context, roomID, id string, archived bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// advisory-first: the UPDATE takes an FK row lock on rooms before appendEventTx
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return err
	}
	res, err := tx.Exec(ctx,
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
	// same tx as the UPDATE: a crash between them must not archive silently
	payload, _ := json.Marshal(map[string]string{"channel_id": id})
	if err := appendEventTx(ctx, tx, roomID, typ, payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
