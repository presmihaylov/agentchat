package models

import (
	"context"
	"time"
)

// ThreadSummary is one row of a participant's thread tree.
type ThreadSummary struct {
	RootID      string     `json:"root_id"`
	ChannelID   string     `json:"channel_id"`
	Body        string     `json:"body"`
	AuthorID    string     `json:"author_id"`
	AuthorName  string     `json:"author_name"`
	CreatedAt   time.Time  `json:"created_at"`
	ReplyCount  int64      `json:"reply_count"`
	LastReplyAt *time.Time `json:"last_reply_at,omitempty"`
	Muted       bool       `json:"muted"`
	LastReadAt  *time.Time `json:"last_read_at,omitempty"`
	UnreadCount int64      `json:"unread_count"`
	// UnreadMentions counts the unread replies that @mention the viewer
	// (direct or broadcast); the sidebar leaf badges this, glow otherwise.
	UnreadMentions int64 `json:"unread_mentions"`
	// Subscribed marks an explicit right-click follow, as opposed to the
	// implicit involvement from posting or being mentioned.
	Subscribed bool `json:"subscribed"`
	// LastActivityAt is the newest message in the thread, root included: the
	// clock the sidebar auto-archive runs on.
	LastActivityAt time.Time `json:"last_activity_at"`
	// Resolved is a manual archive; only listed when the caller asks for
	// archived threads. Any new reply clears it.
	Resolved bool `json:"resolved"`
	// UnarchivedAt is set by a manual unarchive so the client keeps the thread
	// visible until it is active again, instead of re-hiding it at once.
	UnarchivedAt *time.Time `json:"unarchived_at,omitempty"`
}

// ListInvolvedThreads returns the channel's threads the participant is part of.
func (s *Store) ListInvolvedThreads(ctx context.Context, roomID, channelID, participantID string) ([]ThreadSummary, error) {
	return s.involvedThreads(ctx, roomID, participantID, &channelID, false)
}

// ListInvolvedThreadsRoom is ListInvolvedThreads across every channel in the
// room, each row tagged with its channel_id so the sidebar can nest threads
// under their parent channel (Discord-style).
func (s *Store) ListInvolvedThreadsRoom(ctx context.Context, roomID, participantID string) ([]ThreadSummary, error) {
	return s.involvedThreads(ctx, roomID, participantID, nil, false)
}

// ListInvolvedThreadsRoomAll is ListInvolvedThreadsRoom plus the threads the
// participant archived by hand, flagged Resolved, so the web sidebar can keep
// an "Archived" section. The default listing stays as agents know it.
func (s *Store) ListInvolvedThreadsRoomAll(ctx context.Context, roomID, participantID string) ([]ThreadSummary, error) {
	return s.involvedThreads(ctx, roomID, participantID, nil, true)
}

// involvedThreads lists the threads the participant is part of (started,
// replied in, or mentioned anywhere in), newest activity first. A nil
// channelID spans the whole room; a non-nil one scopes to that channel.
// Unread counts replies from others after the thread's read marker (join
// time when the thread was never opened).
func (s *Store) involvedThreads(ctx context.Context, roomID, participantID string, channelID *string, includeResolved bool) ([]ThreadSummary, error) {
	rows, err := s.pool.Query(ctx,
		`WITH involved AS (
		   SELECT DISTINCT COALESCE(m.thread_root_id, m.id) AS root_id
		   FROM messages m
		   LEFT JOIN mentions mn ON mn.message_id = m.id AND mn.participant_id = $2
		   WHERE m.room_id = $1 AND ($3::uuid IS NULL OR m.channel_id = $3::uuid)
		     AND (m.author_id = $2 OR mn.participant_id IS NOT NULL)
		   UNION
		   SELECT ts2.root_id
		   FROM thread_states ts2
		   JOIN messages rm ON rm.id = ts2.root_id
		   WHERE ts2.participant_id = $2 AND ts2.subscribed
		     AND rm.room_id = $1 AND ($3::uuid IS NULL OR rm.channel_id = $3::uuid)
		 )
		 SELECT r.id, r.channel_id, r.body, r.author_id, ap.name, r.created_at,
		        (SELECT count(*) FROM messages c WHERE c.thread_root_id = r.id) AS reply_count,
		        (SELECT max(c.created_at) FROM messages c WHERE c.thread_root_id = r.id) AS last_reply_at,
		        COALESCE(ts.muted, false),
		        ts.last_read_at,
		        (SELECT count(*) FROM messages c WHERE c.thread_root_id = r.id
		           AND c.author_id <> $2
		           AND c.created_at > COALESCE(ts.last_read_at, p.created_at)) AS unread,
		        (SELECT count(*) FROM messages c WHERE c.thread_root_id = r.id
		           AND c.author_id <> $2
		           AND c.created_at > COALESCE(ts.last_read_at, p.created_at)
		           AND (c.is_broadcast OR EXISTS (
		                SELECT 1 FROM mentions mn2
		                WHERE mn2.message_id = c.id AND mn2.participant_id = $2))) AS unread_mentions,
		        COALESCE(ts.subscribed, false),
		        COALESCE((SELECT max(c.created_at) FROM messages c WHERE c.thread_root_id = r.id), r.created_at) AS last_activity_at,
		        ts.resolved_at IS NOT NULL,
		        ts.unarchived_at
		 FROM involved i
		 JOIN messages r ON r.id = i.root_id
		 JOIN participants ap ON ap.id = r.author_id
		 JOIN participants p ON p.id = $2
		 JOIN channel_members cm ON cm.channel_id = r.channel_id AND cm.participant_id = $2
		 LEFT JOIN thread_states ts ON ts.root_id = r.id AND ts.participant_id = $2
		 WHERE (EXISTS (SELECT 1 FROM messages c WHERE c.thread_root_id = r.id)
		        OR COALESCE(ts.subscribed, false))
		   AND ($4 OR ts.resolved_at IS NULL)
		 ORDER BY COALESCE((SELECT max(c.created_at) FROM messages c WHERE c.thread_root_id = r.id), r.created_at) DESC`,
		roomID, participantID, channelID, includeResolved)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ThreadSummary{}
	for rows.Next() {
		var t ThreadSummary
		if err := rows.Scan(&t.RootID, &t.ChannelID, &t.Body, &t.AuthorID, &t.AuthorName, &t.CreatedAt,
			&t.ReplyCount, &t.LastReplyAt, &t.Muted, &t.LastReadAt, &t.UnreadCount, &t.UnreadMentions, &t.Subscribed,
			&t.LastActivityAt, &t.Resolved, &t.UnarchivedAt); err != nil {
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

// SetThreadSubscribed adds (true) or removes (false) an explicit follow of the
// thread for the participant. An unsubscribed thread the participant posted or
// was mentioned in stays in the tree via the implicit involvement rules.
func (s *Store) SetThreadSubscribed(ctx context.Context, participantID, rootID string, subscribed bool) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO thread_states (participant_id, root_id, subscribed)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (participant_id, root_id) DO UPDATE SET subscribed = $3`,
		participantID, rootID, subscribed)
	return err
}

// SetThreadLeft takes the participant out of (left=true) or back into
// (left=false) the thread's participant list on future events. A direct
// @mention or the participant's own reply also clears it (see CreateMessage).
func (s *Store) SetThreadLeft(ctx context.Context, participantID, rootID string, left bool) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO thread_states (participant_id, root_id, left_at)
		 VALUES ($1, $2, CASE WHEN $3 THEN now() END)
		 ON CONFLICT (participant_id, root_id)
		 DO UPDATE SET left_at = CASE WHEN $3 THEN now() END`,
		participantID, rootID, left)
	return err
}

// SetThreadResolved hides (resolve=true) or restores a thread in the
// participant's sidebar tree. A later direct @mention clears this the same way
// it clears mute (see CreateMessage), so a resolved thread can resurface.
func (s *Store) SetThreadResolved(ctx context.Context, participantID, rootID string, resolved bool) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO thread_states (participant_id, root_id, resolved_at, unarchived_at)
		 VALUES ($1, $2, CASE WHEN $3 THEN now() END, CASE WHEN NOT $3 THEN now() END)
		 ON CONFLICT (participant_id, root_id)
		 DO UPDATE SET resolved_at = CASE WHEN $3 THEN now() END,
		               unarchived_at = CASE WHEN $3 THEN thread_states.unarchived_at ELSE now() END`,
		participantID, rootID, resolved)
	return err
}
