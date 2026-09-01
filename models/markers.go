package models

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// assertMessageInRoom fails with ErrNotFound if the message is not in the room.
func assertMessageInRoom(ctx context.Context, tx pgx.Tx, roomID, messageID string) error {
	var one int
	err := tx.QueryRow(ctx,
		`SELECT 1 FROM messages WHERE id = $1 AND room_id = $2`, messageID, roomID).Scan(&one)
	return mapRowErr(err)
}

// SetMessageMarker sets (or updates) the caller's "working on it" marker on a
// message and emits a message.working event. Repeat calls just refresh status
// and updated_at, so an agent can advance the label as work progresses.
func (s *Store) SetMessageMarker(ctx context.Context, roomID, messageID, agentID, status string) (MessageMarker, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MessageMarker{}, err
	}
	defer tx.Rollback(ctx)

	// advisory-first, like CreateMessage: this tx takes FK key-share locks before
	// appendEventTx, so lock the room events advisory up front to keep lock order.
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return MessageMarker{}, err
	}
	if err := assertMessageInRoom(ctx, tx, roomID, messageID); err != nil {
		return MessageMarker{}, err
	}

	m := MessageMarker{MessageID: messageID, AgentID: agentID, Status: status}
	err = tx.QueryRow(ctx,
		`INSERT INTO message_markers (message_id, agent_id, status)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (message_id, agent_id)
		 DO UPDATE SET status = $3, updated_at = now()
		 RETURNING updated_at`,
		messageID, agentID, status).Scan(&m.UpdatedAt)
	if err != nil {
		// agent_id or message_id gone between the check and the upsert
		if isForeignKeyViolation(err) {
			return MessageMarker{}, ErrNotFound
		}
		return MessageMarker{}, err
	}
	if err := tx.QueryRow(ctx,
		`SELECT name, avatar FROM participants WHERE id = $1`, agentID).
		Scan(&m.AgentName, &m.Avatar); err != nil {
		return MessageMarker{}, mapRowErr(err)
	}

	payload, err := json.Marshal(m)
	if err != nil {
		return MessageMarker{}, err
	}
	if err := appendEventTx(ctx, tx, roomID, "message.working", payload); err != nil {
		return MessageMarker{}, err
	}
	return m, tx.Commit(ctx)
}

// ClearMessageMarker removes the caller's marker from a message and emits a
// message.working.cleared event. It is idempotent: clearing an absent marker
// still succeeds (and still emits), so a double-DELETE is not an error.
func (s *Store) ClearMessageMarker(ctx context.Context, roomID, messageID, agentID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return err
	}
	if err := assertMessageInRoom(ctx, tx, roomID, messageID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM message_markers WHERE message_id = $1 AND agent_id = $2`,
		messageID, agentID); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"message_id": messageID, "agent_id": agentID})
	if err := appendEventTx(ctx, tx, roomID, "message.working.cleared", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListAgentMarkers returns the caller's own active markers, oldest first. A
// marker outlives the work it describes if the agent forgets to clear it, and
// until this existed there was no way to see your own: you had to notice the
// badge in somebody else's UI. Oldest first because the stale one is the point.
func (s *Store) ListAgentMarkers(ctx context.Context, roomID, agentID string) ([]AgentMarker, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT mk.message_id, mk.agent_id, p.name, p.avatar, mk.status, mk.updated_at,
		        m.channel_id, c.name, left(m.body, 120)
		   FROM message_markers mk
		   JOIN messages m ON m.id = mk.message_id
		   JOIN channels c ON c.id = m.channel_id
		   JOIN participants p ON p.id = mk.agent_id
		  WHERE mk.agent_id = $1 AND m.room_id = $2
		  ORDER BY mk.updated_at ASC`, agentID, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []AgentMarker{}
	for rows.Next() {
		var a AgentMarker
		if err := rows.Scan(&a.MessageID, &a.AgentID, &a.AgentName, &a.Avatar, &a.Status,
			&a.UpdatedAt, &a.ChannelID, &a.ChannelName, &a.Preview); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
