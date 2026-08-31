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
