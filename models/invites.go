package models

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Invite is a revocable join link. Token is the secret in /join/<token>;
// OwnerID is the principal an agent joining with it gets bound to (nil = none).
type Invite struct {
	ID    string `json:"id"`
	Token string `json:"-"`
	// URL is the shareable link, filled by the API layer
	URL           string     `json:"url,omitempty"`
	RoomID        string     `json:"room_id"`
	CreatedBy     *string    `json:"created_by,omitempty"`
	CreatedByName *string    `json:"created_by_name,omitempty"`
	OwnerID       *string    `json:"owner_id,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	MaxUses       *int       `json:"max_uses,omitempty"`
	Uses          int        `json:"uses"`
	RevokedAt     *time.Time `json:"revoked_at,omitempty"`
	// Status is active, expired, exhausted or revoked, computed at read time.
	Status string `json:"status"`
}

var (
	ErrInviteExpired   = errors.New("that invite link has expired")
	ErrInviteExhausted = errors.New("that invite link has reached its use limit")
	ErrInviteRevoked   = errors.New("that invite link was revoked")
)

const inviteColumns = `v.id, v.token, v.room_id, v.created_by, c.name, v.owner_id, v.created_at, v.expires_at, v.max_uses, v.uses, v.revoked_at,
	CASE WHEN v.revoked_at IS NOT NULL THEN 'revoked'
	     WHEN v.expires_at IS NOT NULL AND v.expires_at <= now() THEN 'expired'
	     WHEN v.max_uses IS NOT NULL AND v.uses >= v.max_uses THEN 'exhausted'
	     ELSE 'active' END`

const inviteFrom = ` FROM invites v LEFT JOIN participants c ON c.id = v.created_by `

func scanInvite(row pgx.Row, v *Invite) error {
	return row.Scan(&v.ID, &v.Token, &v.RoomID, &v.CreatedBy, &v.CreatedByName, &v.OwnerID, &v.CreatedAt,
		&v.ExpiresAt, &v.MaxUses, &v.Uses, &v.RevokedAt, &v.Status)
}

// statusErr maps a link's computed status to the error a joiner sees.
func (v Invite) statusErr() error {
	switch v.Status {
	case "revoked":
		return ErrInviteRevoked
	case "expired":
		return ErrInviteExpired
	case "exhausted":
		return ErrInviteExhausted
	}
	return nil
}

// CreateInvite mints a link. ownerID binds agents that join with it to that
// principal; createdBy is the minting participant (nil for a system link).
func (s *Store) CreateInvite(ctx context.Context, roomID, token string, createdBy, ownerID *string, expiresAt *time.Time, maxUses *int) (Invite, error) {
	var v Invite
	err := scanInvite(s.pool.QueryRow(ctx,
		`WITH ins AS (
		   INSERT INTO invites (token, room_id, created_by, owner_id, expires_at, max_uses)
		   VALUES ($1, $2, $3, $4, $5, $6) RETURNING *)
		 SELECT `+inviteColumns+` FROM ins v LEFT JOIN participants c ON c.id = v.created_by`,
		token, roomID, createdBy, ownerID, expiresAt, maxUses), &v)
	return v, err
}

// ListInvites returns a room's links that are not revoked, oldest first.
func (s *Store) ListInvites(ctx context.Context, roomID string) ([]Invite, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+inviteColumns+inviteFrom+`WHERE v.room_id = $1 AND v.revoked_at IS NULL ORDER BY v.created_at`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		var v Invite
		if err := scanInvite(rows, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// RevokeInvite kills a link of this room; a foreign or unknown id is ErrNotFound.
func (s *Store) RevokeInvite(ctx context.Context, roomID, id string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE invites SET revoked_at = now() WHERE room_id = $1 AND id = $2 AND revoked_at IS NULL`, roomID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// InviteByToken resolves a link and the room it opens. A dead link comes back
// with its status error so the caller can say why; unknown is ErrNotFound.
// A link whose owner was kicked is dead too: ownership must chain to a live
// principal.
func (s *Store) InviteByToken(ctx context.Context, token string) (Invite, Room, error) {
	var v Invite
	var r Room
	var ownerRevoked bool
	err := s.pool.QueryRow(ctx,
		`SELECT `+inviteColumns+`, `+roomColumnsOf("r")+`, COALESCE(o.revoked, false)
		 `+inviteFrom+`
		 JOIN rooms r ON r.id = v.room_id
		 LEFT JOIN participants o ON o.id = v.owner_id
		 WHERE v.token = $1`, token,
	).Scan(append(append([]any{&v.ID, &v.Token, &v.RoomID, &v.CreatedBy, &v.CreatedByName, &v.OwnerID, &v.CreatedAt,
		&v.ExpiresAt, &v.MaxUses, &v.Uses, &v.RevokedAt, &v.Status}, roomDest(&r)...), &ownerRevoked)...)
	if err != nil {
		return v, r, mapRowErr(err)
	}
	r.AvatarURL = AvatarPath(r.AvatarAttachmentID)
	if ownerRevoked {
		return v, r, ErrInviteRevoked
	}
	return v, r, v.statusErr()
}

// consumeInviteTx spends one use. The predicate re-checks every limit under
// the row lock, so two joiners racing for the last use of a link get exactly
// one winner. Call it after lockRoomEvents.
func consumeInviteTx(ctx context.Context, tx pgx.Tx, inviteID string) error {
	var status string
	err := tx.QueryRow(ctx,
		`UPDATE invites v SET uses = uses + 1
		 WHERE id = $1 AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > now())
		   AND (max_uses IS NULL OR uses < max_uses)
		 RETURNING 'active'`, inviteID).Scan(&status)
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// lost the race or the link died meanwhile: report the exact reason
	var v Invite
	if err := scanInvite(tx.QueryRow(ctx, `SELECT `+inviteColumns+inviteFrom+`WHERE v.id = $1`, inviteID), &v); err != nil {
		return mapRowErr(err)
	}
	if e := v.statusErr(); e != nil {
		return e
	}
	return ErrInviteInvalid
}

// revokeInvitesOfTx kills every link a participant minted or is the owner of;
// kicking them must not leave a way back in, nor a listed link that binds
// agents to a gone principal.
func revokeInvitesOfTx(ctx context.Context, tx pgx.Tx, roomID, participantID string) error {
	_, err := tx.Exec(ctx,
		`UPDATE invites SET revoked_at = now()
		 WHERE room_id = $1 AND (created_by = $2 OR owner_id = $2) AND revoked_at IS NULL`, roomID, participantID)
	return err
}
