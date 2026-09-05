package models

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// participantNameRe: 2-32 chars, letters, digits, single inner spaces, - or _.
// The API layer validates joins with it; the store derives human names with it.
var participantNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*( [A-Za-z0-9_-]+)*$`)

const maxParticipantName = 32

func ValidParticipantName(name string) bool {
	return len(name) >= 2 && len(name) <= maxParticipantName && participantNameRe.MatchString(name)
}

// HumanParticipantName is the row name a logged-in user gets: the display name
// when it is a valid participant name, else the username (always valid).
func HumanParticipantName(u User) string {
	if ValidParticipantName(u.DisplayName) {
		return u.DisplayName
	}
	return u.Username
}

const humanAvatar = "🧑"

// freeParticipantName returns base, or base-2, base-3, ... against the room's rows.
func freeParticipantName(ctx context.Context, tx pgx.Tx, roomID, base string) (string, error) {
	name := base
	for k := 2; ; k++ {
		var taken bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM participants WHERE room_id = $1 AND name = $2)`,
			roomID, name).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return name, nil
		}
		suffix := fmt.Sprintf("-%d", k)
		stem := base
		if len(stem)+len(suffix) > maxParticipantName {
			stem = stem[:maxParticipantName-len(suffix)]
		}
		name = stem + suffix
	}
}

// CreateRoomAs creates a workspace for a logged-in user: the room, #general and
// the creator's admin participant (linked, no token) in one transaction.
// At most RoomQuota rooms per creator, counted under a per-user advisory lock.
// expiresAt (nil = never) is when the workspace turns read-only; see SetRoomExpiry.
func (s *Store) CreateRoomAs(ctx context.Context, name, slug, secret string, creator User, expiresAt *time.Time) (Room, Participant, error) {
	var r Room
	var p Participant
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, p, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('room-create:' || $1))`, creator.ID); err != nil {
		return r, p, err
	}
	var owned int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM rooms WHERE created_by_user_id = $1`, creator.ID).Scan(&owned); err != nil {
		return r, p, err
	}
	if owned >= RoomQuota {
		return r, p, ErrRoomQuota
	}

	err = scanRoom(tx.QueryRow(ctx,
		`INSERT INTO rooms (name, slug, secret, created_by_user_id, color, expires_at) VALUES ($1, $2, $3, $4, floor(random() * $5), $6)
		 RETURNING `+roomColumns,
		name, slug, secret, creator.ID, RoomColorSlots, expiresAt,
	), &r)
	if err != nil {
		if isUniqueViolation(err) {
			return r, p, ErrConflict
		}
		return r, p, err
	}
	// room lock before the participant insert takes its FK row lock on rooms
	if err := lockRoomEvents(ctx, tx, r.ID); err != nil {
		return r, p, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO channels (room_id, name, topic) VALUES ($1, 'general', 'General discussion')`, r.ID); err != nil {
		return r, p, err
	}
	payload, _ := json.Marshal(map[string]string{"room_id": r.ID, "name": r.Name})
	if err := appendEventTx(ctx, tx, r.ID, "room.created", payload); err != nil {
		return r, p, err
	}

	p, err = createParticipantTx(ctx, tx, r.ID, HumanParticipantName(creator), humanAvatar, "", true, nil, nil, &creator.ID)
	if err != nil {
		return r, p, err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET last_active_room_id = $2 WHERE id = $1`, creator.ID, r.ID); err != nil {
		return r, p, err
	}
	return r, p, tx.Commit(ctx)
}

// EnterRoom adds a logged-in user to a room as a fresh linked participant. It
// never adopts an existing row: a taken name gets -2, -3. Humans are their own
// principal, so an owner-scoped code binds nobody here, exactly as in /join.
func (s *Store) EnterRoom(ctx context.Context, roomID string, user User) (Participant, error) {
	var p Participant
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return p, err
	}
	defer tx.Rollback(ctx)

	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return p, err
	}
	name, err := freeParticipantName(ctx, tx, roomID, HumanParticipantName(user))
	if err != nil {
		return p, err
	}
	p, err = createParticipantTx(ctx, tx, roomID, name, humanAvatar, "", true, nil, nil, &user.ID)
	if err != nil {
		return p, err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET last_active_room_id = $2 WHERE id = $1`, user.ID, roomID); err != nil {
		return p, err
	}
	return p, tx.Commit(ctx)
}

// ParticipantForUser finds the user's row in a room, revoked or not.
func (s *Store) ParticipantForUser(ctx context.Context, roomID, userID string) (Participant, error) {
	var p Participant
	err := s.pool.QueryRow(ctx,
		`SELECT `+scopeParticipantColumns+`
		 FROM participants p LEFT JOIN participants o ON o.id = p.owner_id
		 WHERE p.room_id = $1 AND p.user_id = $2`,
		roomID, userID, OnlineWindow.String(),
	).Scan(scopeParticipantDest(&p)...)
	return p, mapRowErr(err)
}

const scopeParticipantColumns = `p.id, p.room_id, p.name, p.avatar, p.avatar_attachment_id, p.description, p.is_human, p.role,
		        p.owner_id, o.name, p.user_id, p.revoked, p.last_seen_at, p.created_at,
		        p.last_seen_at > now() - $3::interval`

func scopeParticipantDest(p *Participant) []any {
	return []any{&p.ID, &p.RoomID, &p.Name, &p.Avatar, &p.AvatarAttachmentID, &p.Description, &p.IsHuman, &p.Role,
		&p.OwnerID, &p.OwnerName, &p.UserID, &p.Revoked, &p.LastSeenAt, &p.CreatedAt, &p.Online}
}

// Scope is what a session resolves to on a room route.
type Scope struct {
	Session Session
	User    User
	// RoomID is nil when no room has the requested slug.
	RoomID *string
	// Participant is nil when the user has no row in the room; a revoked row
	// is returned with Revoked set so the caller can name the reason.
	Participant *Participant
}

// SessionScope resolves a ses_ token plus a room slug in one statement: the
// session (touched like SessionByTokenHash), its user, the room and the
// user's participant row there. A live participant moves the user's
// last_active_room_id pointer when it differs.
func (s *Store) SessionScope(ctx context.Context, tokenHash []byte, slug string, ttl time.Duration) (Scope, error) {
	var sc Scope
	var roomID *string
	// every participant column is NULL when the user has no row, so they land
	// in nullable temporaries first
	var pid, pRoomID, pName, pAvatar, pDescription, pRole *string
	var pIsHuman, pRevoked, pOnline *bool
	var pLastSeen, pCreated *time.Time
	var p Participant
	err := s.pool.QueryRow(ctx,
		`WITH touched AS (
		     UPDATE sessions SET last_used_at = now(),
		            expires_at = LEAST(now() + $3::interval, created_at + $4::interval)
		     WHERE token_hash = $1 AND expires_at > now()
		       AND created_at > now() - $4::interval
		       AND last_used_at < now() - $5::interval
		     RETURNING id, last_used_at, expires_at
		 )
		 SELECT s.id, s.user_id, s.provider, s.created_at,
		        COALESCE(t.last_used_at, s.last_used_at), COALESCE(t.expires_at, s.expires_at),
		        `+userColumns+`,
		        r.id,
		        p.id, p.room_id, p.name, p.avatar, p.avatar_attachment_id, p.description, p.is_human, p.role,
		        p.owner_id, o.name, p.user_id, p.revoked, p.last_seen_at, p.created_at,
		        p.last_seen_at > now() - $6::interval
		 FROM sessions s
		 JOIN users u ON u.id = s.user_id
		 LEFT JOIN touched t ON t.id = s.id
		 LEFT JOIN rooms r ON r.slug = $2
		 LEFT JOIN participants p ON p.room_id = r.id AND p.user_id = u.id
		 LEFT JOIN participants o ON o.id = p.owner_id
		 WHERE s.token_hash = $1 AND s.expires_at > now() AND s.created_at > now() - $4::interval`,
		tokenHash, slug, ttl.String(), SessionMaxAge.String(), SessionTouchEvery.String(), OnlineWindow.String(),
	).Scan(&sc.Session.ID, &sc.Session.UserID, &sc.Session.Provider, &sc.Session.CreatedAt, &sc.Session.LastUsedAt, &sc.Session.ExpiresAt,
		&sc.User.ID, &sc.User.Username, &sc.User.DisplayName, &sc.User.Email, &sc.User.MustChangePassword, &sc.User.LastActiveWorkspaceID, &sc.User.CreatedAt,
		&roomID,
		&pid, &pRoomID, &pName, &pAvatar, &p.AvatarAttachmentID, &pDescription, &pIsHuman, &pRole,
		&p.OwnerID, &p.OwnerName, &p.UserID, &pRevoked, &pLastSeen, &pCreated, &pOnline)
	if err != nil {
		return sc, mapRowErr(err)
	}
	sc.RoomID = roomID
	if pid == nil {
		return sc, nil
	}
	p.ID, p.RoomID, p.Name, p.Avatar, p.Description, p.Role = *pid, *pRoomID, *pName, *pAvatar, *pDescription, *pRole
	p.IsHuman, p.Revoked, p.Online = *pIsHuman, *pRevoked, *pOnline
	p.LastSeenAt, p.CreatedAt = *pLastSeen, *pCreated
	sc.Participant = &p
	if p.Revoked {
		return sc, nil
	}
	if sc.User.LastActiveWorkspaceID != nil && *sc.User.LastActiveWorkspaceID == *roomID {
		return sc, nil
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET last_active_room_id = $2 WHERE id = $1`, sc.User.ID, *roomID); err != nil {
		return sc, err
	}
	sc.User.LastActiveWorkspaceID = roomID
	return sc, nil
}

// UserRoom is one switcher entry: a room the user is a live participant of.
type UserRoom struct {
	ID                 string    `json:"id"`
	Slug               string    `json:"slug"`
	Name               string    `json:"name"`
	Role               string    `json:"role"`
	JoinedAt           time.Time `json:"joined_at"`
	AvatarAttachmentID *string   `json:"avatar_attachment_id,omitempty"`
	AvatarURL          string    `json:"avatar_url,omitempty"`
	Color              int16     `json:"color"`
	// Unread and Mentions roll up the channel badges of this user's participant:
	// a muted channel counts only through its mentions, like the sidebar
	ExpiresAt *time.Time `json:"expires_at"`
	Expired   bool       `json:"expired"`
	Unread    bool       `json:"unread"`
	Mentions  int64      `json:"mentions"`
}

// RoomsByUser lists the rooms the user still has a live row in, oldest
// membership first. Revoked rows do not count. The read state is the channel
// badge rule from ListChannelsUnread over the participant's live channels;
// unread is an EXISTS so a busy unread channel stops at its first row.
func (s *Store) RoomsByUser(ctx context.Context, userID string) ([]UserRoom, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT r.id, r.slug, r.name, p.role, p.created_at, r.avatar_attachment_id, r.color, r.expires_at,
		        EXISTS (
		          SELECT 1 FROM channel_members cm
		          JOIN channels c ON c.id = cm.channel_id AND NOT c.archived
		          LEFT JOIN channel_reads rd ON rd.channel_id = c.id AND rd.participant_id = p.id
		          JOIN messages m ON m.channel_id = c.id AND m.thread_root_id IS NULL
		               AND m.author_id <> p.id AND m.kind <> 'system'
		               AND m.created_at > COALESCE(rd.last_read_at, p.created_at)
		          WHERE cm.participant_id = p.id
		            AND (NOT cm.muted OR m.is_broadcast OR EXISTS (
		                 SELECT 1 FROM mentions mn WHERE mn.message_id = m.id AND mn.participant_id = p.id))) AS unread,
		        (SELECT count(*) FROM channel_members cm
		          JOIN channels c ON c.id = cm.channel_id AND NOT c.archived
		          LEFT JOIN channel_reads rd ON rd.channel_id = c.id AND rd.participant_id = p.id
		          JOIN messages m ON m.channel_id = c.id AND m.thread_root_id IS NULL
		               AND m.author_id <> p.id AND m.kind <> 'system'
		               AND m.created_at > COALESCE(rd.last_read_at, p.created_at)
		          WHERE cm.participant_id = p.id
		            AND (m.is_broadcast OR EXISTS (
		                 SELECT 1 FROM mentions mn WHERE mn.message_id = m.id AND mn.participant_id = p.id))) AS mentions
		 FROM participants p JOIN rooms r ON r.id = p.room_id
		 WHERE p.user_id = $1 AND NOT p.revoked
		 ORDER BY p.created_at, r.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserRoom{}
	for rows.Next() {
		var ur UserRoom
		if err := rows.Scan(&ur.ID, &ur.Slug, &ur.Name, &ur.Role, &ur.JoinedAt, &ur.AvatarAttachmentID, &ur.Color, &ur.ExpiresAt, &ur.Unread, &ur.Mentions); err != nil {
			return nil, err
		}
		ur.AvatarURL = AvatarPath(ur.AvatarAttachmentID)
		ur.Expired = ur.ExpiresAt != nil && !ur.ExpiresAt.After(time.Now())
		out = append(out, ur)
	}
	return out, rows.Err()
}
