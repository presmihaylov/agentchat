package models

import (
	"context"
)

// CreateInvite stores an owner-scoped invite code issued by a participant.
func (s *Store) CreateInvite(ctx context.Context, roomID, issuerID, secret string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO invites (secret, room_id, issuer_id) VALUES ($1, $2, $3)`,
		secret, roomID, issuerID)
	return err
}

// RoomByAnySecret resolves an invite code: the room-level code (no owner) or
// an owner-scoped one. The owner is the issuer's principal — the issuer when
// human, otherwise the issuer's own owner — so ownership chains to a human.
func (s *Store) RoomByAnySecret(ctx context.Context, secret string) (Room, *string, error) {
	room, err := s.RoomBySecret(ctx, secret)
	if err == nil {
		return room, nil, nil
	}

	var r Room
	var owner string
	err = s.pool.QueryRow(ctx,
		`SELECT r.id, r.slug, r.secret, r.name, r.created_by_user_id, r.created_at,
		        CASE WHEN i.is_human THEN i.id ELSE COALESCE(i.owner_id, i.id) END
		 FROM invites v
		 JOIN rooms r ON r.id = v.room_id
		 JOIN participants i ON i.id = v.issuer_id
		 WHERE v.secret = $1 AND NOT i.revoked`,
		secret,
	).Scan(&r.ID, &r.Slug, &r.Secret, &r.Name, &r.CreatedByUserID, &r.CreatedAt, &owner)
	if err != nil {
		return r, nil, mapRowErr(err)
	}
	return r, &owner, nil
}
