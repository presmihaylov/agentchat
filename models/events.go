package models

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

func appendEventTx(ctx context.Context, tx pgx.Tx, roomID, typ string, payload json.RawMessage) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO events (room_id, type, payload) VALUES ($1, $2, $3)`,
		roomID, typ, payload)
	return err
}

// AppendEvent records a standalone event (mutations done in their own tx append inline).
func (s *Store) AppendEvent(ctx context.Context, roomID, typ string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx,
		`INSERT INTO events (room_id, type, payload) VALUES ($1, $2, $3)`,
		roomID, typ, raw)
	return err
}

// ListEvents returns events with seq > afterSeq, oldest first.
func (s *Store) ListEvents(ctx context.Context, roomID string, afterSeq int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx,
		`SELECT seq, room_id, type, payload, created_at
		 FROM events WHERE room_id = $1 AND seq > $2
		 ORDER BY seq ASC LIMIT $3`,
		roomID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.Seq, &e.RoomID, &e.Type, &e.Payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LatestSeq returns the highest event seq for a room (0 if none).
func (s *Store) LatestSeq(ctx context.Context, roomID string) (int64, error) {
	var seq int64
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(MAX(seq), 0) FROM events WHERE room_id = $1`, roomID,
	).Scan(&seq)
	return seq, err
}
