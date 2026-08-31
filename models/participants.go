package models

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

var ErrLastAdmin = errors.New("a room must keep at least one admin")

// CreateParticipant adds a member; the first participant in a room becomes admin.
func (s *Store) CreateParticipant(ctx context.Context, roomID, name, avatar, description string, isHuman bool, tokenHash []byte) (Participant, error) {
	var p Participant
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return p, err
	}
	defer tx.Rollback(ctx)

	// serialize joins per room so exactly one first joiner becomes admin
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, roomID); err != nil {
		return p, err
	}

	err = tx.QueryRow(ctx,
		`INSERT INTO participants (room_id, name, avatar, description, is_human, token_hash, role)
		 SELECT $1, $2, $3, $4, $5, $6,
		        CASE WHEN EXISTS (SELECT 1 FROM participants WHERE room_id = $1 AND NOT revoked)
		             THEN 'member' ELSE 'admin' END
		 RETURNING id, room_id, name, avatar, description, is_human, role, last_seen_at, created_at`,
		roomID, name, avatar, description, isHuman, tokenHash,
	).Scan(&p.ID, &p.RoomID, &p.Name, &p.Avatar, &p.Description, &p.IsHuman, &p.Role, &p.LastSeenAt, &p.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return p, fmt.Errorf("name %q is taken in this room: %w", name, ErrConflict)
		}
		return p, err
	}
	p.Online = true
	p.Tags = []Tag{}

	payload, _ := json.Marshal(map[string]any{
		"participant_id": p.ID, "name": p.Name, "is_human": p.IsHuman,
		"role": p.Role, "description": p.Description,
	})
	if err := appendEventTx(ctx, tx, roomID, "participant.joined", payload); err != nil {
		return p, err
	}
	return p, tx.Commit(ctx)
}

// ParticipantByTokenHash authenticates a request; revoked participants fail auth.
func (s *Store) ParticipantByTokenHash(ctx context.Context, hash []byte) (Participant, error) {
	var p Participant
	err := s.pool.QueryRow(ctx,
		`SELECT id, room_id, name, avatar, avatar_attachment_id, description, is_human, role, last_seen_at, created_at,
		        last_seen_at > now() - $2::interval AS online
		 FROM participants WHERE token_hash = $1 AND NOT revoked`,
		hash, OnlineWindow.String(),
	).Scan(&p.ID, &p.RoomID, &p.Name, &p.Avatar, &p.AvatarAttachmentID, &p.Description, &p.IsHuman, &p.Role, &p.LastSeenAt, &p.CreatedAt, &p.Online)
	return p, mapRowErr(err)
}

func (s *Store) ParticipantByID(ctx context.Context, roomID, id string) (Participant, error) {
	list, err := s.listParticipants(ctx, roomID, &id, nil)
	if err != nil {
		return Participant{}, err
	}
	if len(list) == 0 {
		return Participant{}, ErrNotFound
	}
	return list[0], nil
}

func (s *Store) ParticipantByName(ctx context.Context, roomID, name string) (Participant, error) {
	list, err := s.listParticipants(ctx, roomID, nil, &name)
	if err != nil {
		return Participant{}, err
	}
	if len(list) == 0 {
		return Participant{}, ErrNotFound
	}
	return list[0], nil
}

// ListParticipants returns active (non-revoked) members.
func (s *Store) ListParticipants(ctx context.Context, roomID string) ([]Participant, error) {
	return s.listParticipants(ctx, roomID, nil, nil)
}

func (s *Store) listParticipants(ctx context.Context, roomID string, id, name *string) ([]Participant, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT p.id, p.room_id, p.name, p.avatar, p.avatar_attachment_id, p.description, p.is_human, p.role,
		        p.last_seen_at, p.created_at,
		        p.last_seen_at > now() - $2::interval AS online,
		        COALESCE(
		            (SELECT json_agg(json_build_object('tag', t.tag, 'tagged_by', tb.name) ORDER BY t.created_at)
		             FROM participant_tags t
		             LEFT JOIN participants tb ON tb.id = t.tagged_by
		             WHERE t.participant_id = p.id),
		            '[]'::json) AS tags
		 FROM participants p
		 WHERE p.room_id = $1 AND NOT p.revoked
		   AND ($3::uuid IS NULL OR p.id = $3)
		   AND ($4::text IS NULL OR p.name = $4)
		 ORDER BY p.created_at ASC`,
		roomID, OnlineWindow.String(), id, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Participant{}
	for rows.Next() {
		var p Participant
		var tagsJSON []byte
		if err := rows.Scan(&p.ID, &p.RoomID, &p.Name, &p.Avatar, &p.AvatarAttachmentID, &p.Description, &p.IsHuman, &p.Role,
			&p.LastSeenAt, &p.CreatedAt, &p.Online, &tagsJSON); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(tagsJSON, &p.Tags); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpdateProfile updates non-nil fields and returns the fresh participant.
func (s *Store) UpdateProfile(ctx context.Context, roomID, id string, name, avatar, description *string) (Participant, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Participant{}, err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`UPDATE participants SET
		    name = COALESCE($3, name),
		    avatar = COALESCE($4, avatar),
		    description = COALESCE($5, description)
		 WHERE room_id = $1 AND id = $2 AND NOT revoked`,
		roomID, id, name, avatar, description)
	if err != nil {
		if isUniqueViolation(err) {
			return Participant{}, ErrConflict
		}
		return Participant{}, err
	}
	if tag.RowsAffected() == 0 {
		return Participant{}, ErrNotFound
	}

	payload, _ := json.Marshal(map[string]any{"participant_id": id})
	if err := appendEventTx(ctx, tx, roomID, "participant.updated", payload); err != nil {
		return Participant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Participant{}, err
	}
	return s.ParticipantByID(ctx, roomID, id)
}

// SetAvatarAttachment points the participant's avatar at an uploaded image
// (nil reverts to the emoji avatar).
func (s *Store) SetAvatarAttachment(ctx context.Context, roomID, id string, attachmentID *string) (Participant, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Participant{}, err
	}
	defer tx.Rollback(ctx)

	res, err := tx.Exec(ctx,
		`UPDATE participants SET avatar_attachment_id = $3
		 WHERE room_id = $1 AND id = $2 AND NOT revoked`,
		roomID, id, attachmentID)
	if err != nil {
		return Participant{}, err
	}
	if res.RowsAffected() == 0 {
		return Participant{}, ErrNotFound
	}

	payload, _ := json.Marshal(map[string]string{"participant_id": id})
	if err := appendEventTx(ctx, tx, roomID, "participant.updated", payload); err != nil {
		return Participant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Participant{}, err
	}
	return s.ParticipantByID(ctx, roomID, id)
}

// SetRole promotes or demotes a participant, never leaving the room without an admin.
func (s *Store) SetRole(ctx context.Context, roomID, id, role string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, roomID); err != nil {
		return err
	}
	if role == "member" {
		var admins int
		err := tx.QueryRow(ctx,
			`SELECT count(*) FROM participants
			 WHERE room_id = $1 AND role = 'admin' AND NOT revoked AND id <> $2`,
			roomID, id).Scan(&admins)
		if err != nil {
			return err
		}
		var isAdmin bool
		if err := tx.QueryRow(ctx,
			`SELECT role = 'admin' FROM participants WHERE room_id = $1 AND id = $2 AND NOT revoked`,
			roomID, id).Scan(&isAdmin); err != nil {
			return mapRowErr(err)
		}
		if isAdmin && admins == 0 {
			return ErrLastAdmin
		}
	}

	res, err := tx.Exec(ctx,
		`UPDATE participants SET role = $3 WHERE room_id = $1 AND id = $2 AND NOT revoked`,
		roomID, id, role)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}

	payload, _ := json.Marshal(map[string]string{"participant_id": id, "role": role})
	if err := appendEventTx(ctx, tx, roomID, "participant.role_changed", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Revoke removes a participant's access but keeps their messages and identity.
func (s *Store) Revoke(ctx context.Context, roomID, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, roomID); err != nil {
		return err
	}
	var isAdmin bool
	if err := tx.QueryRow(ctx,
		`SELECT role = 'admin' FROM participants WHERE room_id = $1 AND id = $2 AND NOT revoked`,
		roomID, id).Scan(&isAdmin); err != nil {
		return mapRowErr(err)
	}
	if isAdmin {
		var others int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM participants
			 WHERE room_id = $1 AND role = 'admin' AND NOT revoked AND id <> $2`,
			roomID, id).Scan(&others); err != nil {
			return err
		}
		if others == 0 {
			return ErrLastAdmin
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE participants SET revoked = true WHERE room_id = $1 AND id = $2`,
		roomID, id); err != nil {
		return err
	}

	payload, _ := json.Marshal(map[string]string{"participant_id": id})
	if err := appendEventTx(ctx, tx, roomID, "participant.revoked", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TouchPresence marks the participant as recently seen.
func (s *Store) TouchPresence(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE participants SET last_seen_at = now() WHERE id = $1`, id)
	return err
}

// GoOffline makes the participant immediately count as offline.
func (s *Store) GoOffline(ctx context.Context, roomID, id string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE participants SET last_seen_at = now() - interval '1 day' WHERE id = $1`, id)
	if err != nil {
		return err
	}
	return s.AppendEvent(ctx, roomID, "participant.offline", map[string]string{"participant_id": id})
}

func (s *Store) AddTag(ctx context.Context, roomID, participantID, tag, taggedBy string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	res, err := tx.Exec(ctx,
		`INSERT INTO participant_tags (participant_id, tag, tagged_by)
		 SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM participants WHERE id = $1 AND room_id = $4)
		 ON CONFLICT DO NOTHING`,
		participantID, tag, taggedBy, roomID)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		// either the participant is gone (404) or the tag already exists (no-op,
		// no duplicate event either way)
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM participants WHERE id = $1 AND room_id = $2)`,
			participantID, roomID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		return nil
	}

	payload, _ := json.Marshal(map[string]string{
		"participant_id": participantID, "tag": tag, "tagged_by": taggedBy,
	})
	if err := appendEventTx(ctx, tx, roomID, "participant.tagged", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RemoveTag(ctx context.Context, roomID, participantID, tag string) error {
	res, err := s.pool.Exec(ctx,
		`DELETE FROM participant_tags t USING participants p
		 WHERE t.participant_id = p.id AND p.room_id = $1 AND t.participant_id = $2 AND t.tag = $3`,
		roomID, participantID, tag)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return s.AppendEvent(ctx, roomID, "participant.untagged",
		map[string]string{"participant_id": participantID, "tag": tag})
}
