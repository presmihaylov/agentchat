package models

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func (s *Store) CreateChannel(ctx context.Context, roomID, name, topic, createdBy string, private bool) (Channel, error) {
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
		`INSERT INTO channels (room_id, name, topic, created_by, private) VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, room_id, name, topic, created_by, archived, private, created_at`,
		roomID, name, topic, createdBy, private,
	).Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.Private, &c.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return c, ErrConflict
		}
		return c, err
	}

	// the creator is the channel's first member
	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, participant_id) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`, c.ID, createdBy); err != nil {
		return c, err
	}

	payload, _ := json.Marshal(map[string]string{"channel_id": c.ID, "name": c.Name, "created_by": createdBy})
	if err := appendEventTx(ctx, tx, roomID, "channel.created", payload); err != nil {
		return c, err
	}
	return c, tx.Commit(ctx)
}

// IsChannelMember reports whether a participant belongs to a channel.
func (s *Store) IsChannelMember(ctx context.Context, channelID, participantID string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND participant_id = $2)`,
		channelID, participantID).Scan(&ok)
	return ok, err
}

// ParticipantChannelIDs returns the channel ids a participant is a member of.
// The event filter uses this to gate content delivery by membership.
func (s *Store) ParticipantChannelIDs(ctx context.Context, participantID string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT channel_id FROM channel_members WHERE participant_id = $1`, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// JoinChannel adds a participant to a channel and emits channel.member_joined.
// Idempotent: joining a channel you are already in changes nothing and reports
// changed=false. The event carries channel_id, so the membership gate delivers
// it only to that channel's members (the new member included). The actor is
// who performed the action (self-join: the participant themselves); it shapes
// the system timeline entry ("joined #x" vs "was added by Y").
func (s *Store) JoinChannel(ctx context.Context, roomID, channelID, participantID, name, actorID, actorName string) (bool, error) {
	return s.setMembership(ctx, roomID, channelID, participantID, name, actorID, actorName, true)
}

// LeaveChannel removes a participant from a channel and emits channel.member_left.
// Idempotent: leaving a channel you are not in reports changed=false.
func (s *Store) LeaveChannel(ctx context.Context, roomID, channelID, participantID, name, actorID, actorName string) (bool, error) {
	return s.setMembership(ctx, roomID, channelID, participantID, name, actorID, actorName, false)
}

func (s *Store) setMembership(ctx context.Context, roomID, channelID, participantID, name, actorID, actorName string, join bool) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	// advisory-first: keep event seq order == commit order, like every writer
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return false, err
	}

	var tag pgconn.CommandTag
	if join {
		tag, err = tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, participant_id) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`, channelID, participantID)
	} else {
		tag, err = tx.Exec(ctx,
			`DELETE FROM channel_members WHERE channel_id = $1 AND participant_id = $2`,
			channelID, participantID)
	}
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, tx.Commit(ctx) // no-op, nothing to announce
	}

	typ := "channel.member_joined"
	if !join {
		typ = "channel.member_left"
	}
	payload, _ := json.Marshal(map[string]string{
		"channel_id": channelID, "participant_id": participantID, "name": name,
	})
	if err := appendEventTx(ctx, tx, roomID, typ, payload); err != nil {
		return false, err
	}

	// Slack-style timeline entry, persisted as a system message so history
	// shows it in place. Authored by the subject; the body carries the rest.
	body := "joined #" + name
	if join && actorID != participantID {
		body = "was added by " + actorName
	}
	if !join {
		body = "left #" + name
		if actorID != participantID {
			body = "was removed by " + actorName
		}
	}
	var msgID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO messages (room_id, channel_id, author_id, body, kind, embed_status)
		 VALUES ($1, $2, $3, $4, 'system', 'skipped') RETURNING id`,
		roomID, channelID, participantID, body).Scan(&msgID); err != nil {
		return false, err
	}
	msg, err := scanMessage(tx.QueryRow(ctx, messageSelect+` WHERE m.id = $1`, msgID))
	if err != nil {
		return false, err
	}
	msgPayload, err := json.Marshal(msg)
	if err != nil {
		return false, err
	}
	// message.created reuses the UI's live feed path; membership-gated like
	// every content event, so only the channel's members render it
	if err := appendEventTx(ctx, tx, roomID, "message.created", msgPayload); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (s *Store) ListChannels(ctx context.Context, roomID string) ([]Channel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, room_id, name, topic, created_by, archived, private, created_at
		 FROM channels WHERE room_id = $1 ORDER BY created_at ASC`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Channel{}
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.Private, &c.CreatedAt); err != nil {
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
		`SELECT c.id, c.room_id, c.name, c.topic, c.created_by, c.archived, c.private, c.created_at,
		        r.last_read_at,
		        (SELECT count(*) FROM messages m
		         WHERE m.channel_id = c.id AND m.thread_root_id IS NULL
		           AND m.author_id <> $2 AND m.kind <> 'system'
		           AND m.created_at > COALESCE(r.last_read_at, p.created_at)) AS unread,
		        (SELECT count(*) FROM messages m
		         WHERE m.channel_id = c.id AND m.thread_root_id IS NULL
		           AND m.author_id <> $2 AND m.kind <> 'system'
		           AND m.created_at > COALESCE(r.last_read_at, p.created_at)
		           AND (m.is_broadcast OR EXISTS (
		                SELECT 1 FROM mentions mn
		                WHERE mn.message_id = m.id AND mn.participant_id = $2))) AS unread_mentions
		 FROM channels c
		 JOIN participants p ON p.id = $2
		 JOIN channel_members cm ON cm.channel_id = c.id AND cm.participant_id = $2
		 LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.participant_id = $2
		 WHERE c.room_id = $1 ORDER BY c.created_at ASC`, roomID, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Channel{}
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.Private,
			&c.CreatedAt, &c.LastReadAt, &c.UnreadCount, &c.UnreadMentions); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// BrowsableChannels lists the channels the caller can join but has not joined:
// every non-archived, non-private channel in the room they are not already a
// member of, with a live member count. Private channels are invite-only and
// never appear here. Sorted by name so the browse list reads alphabetically.
func (s *Store) BrowsableChannels(ctx context.Context, roomID, participantID string) ([]Channel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT c.id, c.room_id, c.name, c.topic, c.created_by, c.archived, c.private, c.created_at,
		        (SELECT count(*) FROM channel_members m WHERE m.channel_id = c.id) AS member_count
		 FROM channels c
		 WHERE c.room_id = $1 AND NOT c.archived AND NOT c.private
		   AND NOT EXISTS (SELECT 1 FROM channel_members cm
		                   WHERE cm.channel_id = c.id AND cm.participant_id = $2)
		 ORDER BY c.name ASC`, roomID, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Channel{}
	for rows.Next() {
		var c Channel
		var count int64
		if err := rows.Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy,
			&c.Archived, &c.Private, &c.CreatedAt, &count); err != nil {
			return nil, err
		}
		c.MemberCount = &count
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
		`SELECT id, room_id, name, topic, created_by, archived, private, created_at
		 FROM channels WHERE room_id = $1 AND id = $2`, roomID, id,
	).Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.Private, &c.CreatedAt)
	return c, mapRowErr(err)
}

func (s *Store) ChannelByName(ctx context.Context, roomID, name string) (Channel, error) {
	var c Channel
	err := s.pool.QueryRow(ctx,
		`SELECT id, room_id, name, topic, created_by, archived, private, created_at
		 FROM channels WHERE room_id = $1 AND name = $2`, roomID, name,
	).Scan(&c.ID, &c.RoomID, &c.Name, &c.Topic, &c.CreatedBy, &c.Archived, &c.Private, &c.CreatedAt)
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
