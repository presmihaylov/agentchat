package models

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

type CreateMessageParams struct {
	RoomID        string
	ChannelID     string
	ThreadRootID  *string
	AuthorID      string
	Body          string
	IsBroadcast   bool
	AttachmentIDs []string
	MentionIDs    []string
}

// messageColumns/messageFrom hydrate messages with author name, attachments,
// mentions and reply counts. Split so searches can append a score column.
const messageColumns = `
	       m.id, m.room_id, m.channel_id, m.thread_root_id, m.author_id, a.name,
	       m.body, m.is_broadcast, m.created_at, m.edited_at,
	       (SELECT count(*) FROM messages r WHERE r.thread_root_id = m.id) AS reply_count,
	       (SELECT max(r.created_at) FROM messages r WHERE r.thread_root_id = m.id) AS last_reply_at,
	       COALESCE(
	           (SELECT json_agg(x.author_id ORDER BY x.last_at DESC)
	            FROM (SELECT r.author_id, max(r.created_at) AS last_at
	                  FROM messages r WHERE r.thread_root_id = m.id
	                  GROUP BY r.author_id ORDER BY last_at DESC LIMIT 3) x),
	           '[]'::json) AS replier_ids,
	       COALESCE(
	           (SELECT json_agg(json_build_object(
	                'id', att.id, 'filename', att.filename, 'content_type', att.content_type,
	                'size_bytes', att.size_bytes, 'created_at', att.created_at) ORDER BY att.created_at)
	            FROM message_attachments ma JOIN attachments att ON att.id = ma.attachment_id
	            WHERE ma.message_id = m.id),
	           '[]'::json) AS attachments,
	       COALESCE(
	           (SELECT json_agg(mp.name ORDER BY mp.name)
	            FROM mentions mn JOIN participants mp ON mp.id = mn.participant_id
	            WHERE mn.message_id = m.id),
	           '[]'::json) AS mentions`

const messageFrom = `
	FROM messages m
	JOIN participants a ON a.id = m.author_id`

const messageSelect = "SELECT" + messageColumns + messageFrom

func scanMessage(row pgx.Row) (Message, error) {
	var m Message
	var attJSON, menJSON, repJSON []byte
	err := row.Scan(&m.ID, &m.RoomID, &m.ChannelID, &m.ThreadRootID, &m.AuthorID, &m.AuthorName,
		&m.Body, &m.IsBroadcast, &m.CreatedAt, &m.EditedAt, &m.ReplyCount, &m.LastReplyAt,
		&repJSON, &attJSON, &menJSON)
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(repJSON, &m.ReplierIDs); err != nil {
		return m, err
	}
	if err := json.Unmarshal(attJSON, &m.Attachments); err != nil {
		return m, err
	}
	if err := json.Unmarshal(menJSON, &m.Mentions); err != nil {
		return m, err
	}
	return m, nil
}

func (s *Store) CreateMessage(ctx context.Context, p CreateMessageParams) (Message, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)

	// archived check inside the tx so a concurrent archive can't race past
	// the handler's pre-check; FOR SHARE blocks the archiver until we commit
	var archived bool
	err = tx.QueryRow(ctx,
		`SELECT archived FROM channels WHERE id = $1 AND room_id = $2 FOR SHARE`,
		p.ChannelID, p.RoomID).Scan(&archived)
	if err != nil {
		return Message{}, mapRowErr(err)
	}
	if archived {
		return Message{}, ErrArchived
	}

	var id string
	err = tx.QueryRow(ctx,
		`INSERT INTO messages (room_id, channel_id, thread_root_id, author_id, body, is_broadcast)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		p.RoomID, p.ChannelID, p.ThreadRootID, p.AuthorID, p.Body, p.IsBroadcast,
	).Scan(&id)
	if err != nil {
		if isForeignKeyViolation(err) {
			return Message{}, ErrNotFound
		}
		return Message{}, err
	}

	for _, attID := range p.AttachmentIDs {
		// join through attachments to guarantee same-room ownership
		res, err := tx.Exec(ctx,
			`INSERT INTO message_attachments (message_id, attachment_id)
			 SELECT $1, id FROM attachments WHERE id = $2 AND room_id = $3`,
			id, attID, p.RoomID)
		if err != nil {
			return Message{}, err
		}
		if res.RowsAffected() == 0 {
			return Message{}, ErrNotFound
		}
	}
	for _, pid := range p.MentionIDs {
		res, err := tx.Exec(ctx,
			`INSERT INTO mentions (message_id, participant_id)
			 SELECT $1, id FROM participants WHERE id = $2 AND room_id = $3
			 ON CONFLICT DO NOTHING`,
			id, pid, p.RoomID)
		if err != nil {
			return Message{}, err
		}
		if res.RowsAffected() == 0 {
			return Message{}, ErrNotFound
		}
		// a direct @mention breaks a thread mute, so the tagged person
		// starts glowing again
		if p.ThreadRootID != nil {
			if _, err := tx.Exec(ctx,
				`UPDATE thread_states SET muted = false
				 WHERE root_id = $1 AND participant_id = $2 AND muted`,
				*p.ThreadRootID, pid); err != nil {
				return Message{}, err
			}
		}
	}

	msg, err := scanMessage(tx.QueryRow(ctx, messageSelect+` WHERE m.id = $1`, id))
	if err != nil {
		return Message{}, err
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		return Message{}, err
	}
	if err := appendEventTx(ctx, tx, p.RoomID, "message.created", payload); err != nil {
		return Message{}, err
	}
	return msg, tx.Commit(ctx)
}

func (s *Store) MessageByID(ctx context.Context, roomID, id string) (Message, error) {
	m, err := scanMessage(s.pool.QueryRow(ctx,
		messageSelect+` WHERE m.id = $1 AND m.room_id = $2`, id, roomID))
	return m, mapRowErr(err)
}

// ListChannelMessages returns top-level messages, oldest first, at most limit.
// before filters strictly older; beforeID (paired with beforeAt) is a tuple
// cursor so pages don't skip or repeat messages sharing a timestamp.
func (s *Store) ListChannelMessages(ctx context.Context, roomID, channelID string, before *time.Time, beforeID *string, beforeAt *time.Time, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 50
	}
	// clamp, don't reset: a too-big limit collapsing to 50 makes paginating
	// clients think they hit the end of history
	if limit > 200 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx,
		messageSelect+`
		 WHERE m.room_id = $1 AND m.channel_id = $2 AND m.thread_root_id IS NULL
		   AND ($3::timestamptz IS NULL OR m.created_at < $3)
		   AND ($4::uuid IS NULL OR (m.created_at, m.id) < ($5::timestamptz, $4::uuid))
		 ORDER BY m.created_at DESC, m.id DESC LIMIT $6`,
		roomID, channelID, before, beforeID, beforeAt, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out, err := collectMessages(rows)
	if err != nil {
		return nil, err
	}
	reverse(out)
	return out, nil
}

// ListThread returns the root message followed by the newest limit replies,
// oldest first. Bounded so a huge autonomous-agent thread can't make one GET
// serialize the whole conversation.
func (s *Store) ListThread(ctx context.Context, roomID, rootID string, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx,
		`SELECT * FROM (
		    SELECT`+messageColumns+messageFrom+`
		     WHERE m.room_id = $1 AND (m.id = $2 OR m.thread_root_id = $2)
		     ORDER BY (m.id = $2) DESC, m.created_at DESC, m.id DESC LIMIT $3
		 ) latest ORDER BY created_at ASC, id ASC`,
		roomID, rootID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out, err := collectMessages(rows)
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

func collectMessages(rows pgx.Rows) ([]Message, error) {
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpdateMessageBody edits a message in place; the edit also re-queues embedding.
func (s *Store) UpdateMessageBody(ctx context.Context, roomID, id, body string) (Message, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)

	res, err := tx.Exec(ctx,
		`UPDATE messages SET body = $3, edited_at = now(), embed_status = 'pending', embed_attempts = 0
		 WHERE room_id = $1 AND id = $2`,
		roomID, id, body)
	if err != nil {
		return Message{}, err
	}
	if res.RowsAffected() == 0 {
		return Message{}, ErrNotFound
	}

	msg, err := scanMessage(tx.QueryRow(ctx, messageSelect+` WHERE m.id = $1`, id))
	if err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return Message{}, err
	}
	if err := appendEventTx(ctx, tx, roomID, "message.edited", payload); err != nil {
		return Message{}, err
	}
	return msg, tx.Commit(ctx)
}

// DeleteMessage removes a message; deleting a thread root deletes its replies (FK cascade).
func (s *Store) DeleteMessage(ctx context.Context, roomID, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	res, err := tx.Exec(ctx,
		`DELETE FROM messages WHERE room_id = $1 AND id = $2`, roomID, id)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	payload, _ := json.Marshal(map[string]string{"message_id": id})
	if err := appendEventTx(ctx, tx, roomID, "message.deleted", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func reverse(ms []Message) {
	for i, j := 0, len(ms)-1; i < j; i, j = i+1, j-1 {
		ms[i], ms[j] = ms[j], ms[i]
	}
}
