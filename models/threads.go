package models

import (
	"context"
	"time"
)

// ThreadSummary is one row of a participant's per-channel thread tree.
type ThreadSummary struct {
	RootID      string     `json:"root_id"`
	Body        string     `json:"body"`
	AuthorID    string     `json:"author_id"`
	AuthorName  string     `json:"author_name"`
	CreatedAt   time.Time  `json:"created_at"`
	ReplyCount  int64      `json:"reply_count"`
	LastReplyAt *time.Time `json:"last_reply_at,omitempty"`
	Muted       bool       `json:"muted"`
	LastReadAt  *time.Time `json:"last_read_at,omitempty"`
	UnreadCount int64      `json:"unread_count"`
}

// ListInvolvedThreads returns the channel's threads the participant is part
// of: started, replied in, or mentioned anywhere in. Newest activity first.
// Unread counts replies from others after the thread's read marker (join time
// when the thread was never opened).
func (s *Store) ListInvolvedThreads(ctx context.Context, roomID, channelID, participantID string) ([]ThreadSummary, error) {
	rows, err := s.pool.Query(ctx,
		`WITH involved AS (
		   SELECT DISTINCT COALESCE(m.thread_root_id, m.id) AS root_id
		   FROM messages m
		   LEFT JOIN mentions mn ON mn.message_id = m.id AND mn.participant_id = $3
		   WHERE m.room_id = $1 AND m.channel_id = $2
		     AND (m.author_id = $3 OR mn.participant_id IS NOT NULL)
		 )
		 SELECT r.id, r.body, r.author_id, ap.name, r.created_at,
		        (SELECT count(*) FROM messages c WHERE c.thread_root_id = r.id) AS reply_count,
		        (SELECT max(c.created_at) FROM messages c WHERE c.thread_root_id = r.id) AS last_reply_at,
		        COALESCE(ts.muted, false),
		        ts.last_read_at,
		        (SELECT count(*) FROM messages c WHERE c.thread_root_id = r.id
		           AND c.author_id <> $3
		           AND c.created_at > COALESCE(ts.last_read_at, p.created_at)) AS unread
		 FROM involved i
		 JOIN messages r ON r.id = i.root_id
		 JOIN participants ap ON ap.id = r.author_id
		 JOIN participants p ON p.id = $3
		 LEFT JOIN thread_states ts ON ts.root_id = r.id AND ts.participant_id = $3
		 WHERE EXISTS (SELECT 1 FROM messages c WHERE c.thread_root_id = r.id)
		 ORDER BY COALESCE((SELECT max(c.created_at) FROM messages c WHERE c.thread_root_id = r.id), r.created_at) DESC`,
		roomID, channelID, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ThreadSummary{}
	for rows.Next() {
		var t ThreadSummary
		if err := rows.Scan(&t.RootID, &t.Body, &t.AuthorID, &t.AuthorName, &t.CreatedAt,
			&t.ReplyCount, &t.LastReplyAt, &t.Muted, &t.LastReadAt, &t.UnreadCount); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// MarkThreadRead advances the thread read marker to now, keeping mute state.
func (s *Store) MarkThreadRead(ctx context.Context, participantID, rootID string) (time.Time, error) {
	var at time.Time
	err := s.pool.QueryRow(ctx,
		`INSERT INTO thread_states (participant_id, root_id, last_read_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (participant_id, root_id) DO UPDATE SET last_read_at = now()
		 RETURNING last_read_at`, participantID, rootID).Scan(&at)
	return at, err
}

// SetThreadMuted follows/unfollows a thread for the participant.
func (s *Store) SetThreadMuted(ctx context.Context, participantID, rootID string, muted bool) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO thread_states (participant_id, root_id, muted)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (participant_id, root_id) DO UPDATE SET muted = $3`,
		participantID, rootID, muted)
	return err
}
