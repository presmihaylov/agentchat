package models

import (
	"context"
	"encoding/json"
	"fmt"
)

func (s *Store) CreateParticipant(ctx context.Context, roomID, name, avatar, description string, isHuman bool, tokenHash []byte) (Participant, error) {
	var p Participant
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return p, err
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx,
		`INSERT INTO participants (room_id, name, avatar, description, is_human, token_hash)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, room_id, name, avatar, description, is_human, last_seen_at, created_at`,
		roomID, name, avatar, description, isHuman, tokenHash,
	).Scan(&p.ID, &p.RoomID, &p.Name, &p.Avatar, &p.Description, &p.IsHuman, &p.LastSeenAt, &p.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return p, fmt.Errorf("name %q is taken in this room: %w", name, ErrConflict)
		}
		return p, err
	}
	p.Online = true
	p.Tags = []Tag{}

	payload, _ := json.Marshal(map[string]any{
		"participant_id": p.ID, "name": p.Name, "is_human": p.IsHuman, "description": p.Description,
	})
	if err := appendEventTx(ctx, tx, roomID, "participant.joined", payload); err != nil {
		return p, err
	}
	return p, tx.Commit(ctx)
}

// ParticipantByTokenHash authenticates a request.
func (s *Store) ParticipantByTokenHash(ctx context.Context, hash []byte) (Participant, error) {
	var p Participant
	err := s.pool.QueryRow(ctx,
		`SELECT id, room_id, name, avatar, description, is_human, last_seen_at, created_at,
		        last_seen_at > now() - $2::interval AS online
		 FROM participants WHERE token_hash = $1`,
		hash, OnlineWindow.String(),
	).Scan(&p.ID, &p.RoomID, &p.Name, &p.Avatar, &p.Description, &p.IsHuman, &p.LastSeenAt, &p.CreatedAt, &p.Online)
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

func (s *Store) ListParticipants(ctx context.Context, roomID string) ([]Participant, error) {
	return s.listParticipants(ctx, roomID, nil, nil)
}

func (s *Store) listParticipants(ctx context.Context, roomID string, id, name *string) ([]Participant, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT p.id, p.room_id, p.name, p.avatar, p.description, p.is_human,
		        p.last_seen_at, p.created_at,
		        p.last_seen_at > now() - $2::interval AS online,
		        COALESCE(
		            (SELECT json_agg(json_build_object('tag', t.tag, 'tagged_by', tb.name) ORDER BY t.created_at)
		             FROM participant_tags t
		             LEFT JOIN participants tb ON tb.id = t.tagged_by
		             WHERE t.participant_id = p.id),
		            '[]'::json) AS tags
		 FROM participants p
		 WHERE p.room_id = $1
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
		if err := rows.Scan(&p.ID, &p.RoomID, &p.Name, &p.Avatar, &p.Description, &p.IsHuman,
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
		 WHERE room_id = $1 AND id = $2`,
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

	_, err = tx.Exec(ctx,
		`INSERT INTO participant_tags (participant_id, tag, tagged_by)
		 SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM participants WHERE id = $1 AND room_id = $4)
		 ON CONFLICT DO NOTHING`,
		participantID, tag, taggedBy, roomID)
	if err != nil {
		return err
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
