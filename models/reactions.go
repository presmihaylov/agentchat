package models

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// MaxReactionsPerMessage caps distinct emoji on one message (Slack stops at 23).
const MaxReactionsPerMessage = 23

// ErrTooManyReactions: the message already carries the maximum distinct emoji.
var ErrTooManyReactions = errors.New("too many distinct reactions on this message")

// messageReactionsTx groups a message's reactions the same way the message
// query does, so the event payload matches what a fresh GET would return.
func messageReactionsTx(ctx context.Context, tx pgx.Tx, messageID string) ([]Reaction, error) {
	rows, err := tx.Query(ctx,
		`SELECT g.emoji, g.n, g.ids, g.names
		   FROM (SELECT mr.emoji, count(*) AS n, min(mr.created_at) AS first_at,
		                json_agg(mr.participant_id ORDER BY mr.created_at) AS ids,
		                json_agg(rp.name ORDER BY mr.created_at) AS names
		           FROM message_reactions mr JOIN participants rp ON rp.id = mr.participant_id
		          WHERE mr.message_id = $1 GROUP BY mr.emoji) g
		  ORDER BY g.first_at`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Reaction{}
	for rows.Next() {
		var r Reaction
		var idsJSON, namesJSON []byte
		if err := rows.Scan(&r.Emoji, &r.Count, &idsJSON, &namesJSON); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(idsJSON, &r.ParticipantIDs); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(namesJSON, &r.Names); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetReaction adds (added=true) or removes the caller's emoji on a message and
// emits one message.reaction event carrying the message's full reaction list
// afterwards. Both directions are idempotent: reacting twice or removing an
// absent reaction still succeeds, and still emits, so a retry never errors.
func (s *Store) SetReaction(ctx context.Context, roomID, messageID, participantID, emoji string, added bool) (ReactionEvent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReactionEvent{}, err
	}
	defer tx.Rollback(ctx)

	// advisory-first, like every event-writing tx (see CreateMessage)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return ReactionEvent{}, err
	}
	ev := ReactionEvent{MessageID: messageID, Emoji: emoji, ParticipantID: participantID, Added: added}
	err = tx.QueryRow(ctx,
		`SELECT m.channel_id, m.thread_root_id, m.author_id, a.name
		   FROM messages m JOIN participants a ON a.id = m.author_id
		  WHERE m.id = $1 AND m.room_id = $2`,
		messageID, roomID).Scan(&ev.ChannelID, &ev.ThreadRootID, &ev.AuthorID, &ev.AuthorName)
	if err != nil {
		return ReactionEvent{}, mapRowErr(err)
	}
	if err := tx.QueryRow(ctx, `SELECT name FROM participants WHERE id = $1`, participantID).
		Scan(&ev.ParticipantName); err != nil {
		return ReactionEvent{}, mapRowErr(err)
	}

	if added {
		var distinct int
		if err := tx.QueryRow(ctx,
			`SELECT count(DISTINCT emoji) FROM message_reactions WHERE message_id = $1 AND emoji <> $2`,
			messageID, emoji).Scan(&distinct); err != nil {
			return ReactionEvent{}, err
		}
		if distinct >= MaxReactionsPerMessage {
			return ReactionEvent{}, ErrTooManyReactions
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO message_reactions (message_id, participant_id, emoji) VALUES ($1, $2, $3)
			 ON CONFLICT DO NOTHING`, messageID, participantID, emoji); err != nil {
			if isForeignKeyViolation(err) {
				return ReactionEvent{}, ErrNotFound
			}
			return ReactionEvent{}, err
		}
	}
	if !added {
		if _, err := tx.Exec(ctx,
			`DELETE FROM message_reactions WHERE message_id = $1 AND participant_id = $2 AND emoji = $3`,
			messageID, participantID, emoji); err != nil {
			return ReactionEvent{}, err
		}
	}

	if ev.Reactions, err = messageReactionsTx(ctx, tx, messageID); err != nil {
		return ReactionEvent{}, err
	}
	payload, err := json.Marshal(ev)
	if err != nil {
		return ReactionEvent{}, err
	}
	if err := appendEventTx(ctx, tx, roomID, "message.reaction", payload); err != nil {
		return ReactionEvent{}, err
	}
	return ev, tx.Commit(ctx)
}
