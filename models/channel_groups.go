package models

import "context"

// ListChannelGroups returns a participant's sidebar sections with the channels
// placed in each, ordered by group position then item position. Groups are
// personal, so this is scoped to participantID and never leaks another's layout.
func (s *Store) ListChannelGroups(ctx context.Context, participantID string) ([]ChannelGroup, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, participant_id, name, position, collapsed, created_at
		 FROM channel_groups WHERE participant_id = $1
		 ORDER BY position ASC, created_at ASC`, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := []ChannelGroup{}
	index := map[string]int{}
	for rows.Next() {
		var g ChannelGroup
		if err := rows.Scan(&g.ID, &g.ParticipantID, &g.Name, &g.Position, &g.Collapsed, &g.CreatedAt); err != nil {
			return nil, err
		}
		g.ChannelIDs = []string{}
		index[g.ID] = len(groups)
		groups = append(groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// second pass: attach the placed channels in order
	irows, err := s.pool.Query(ctx,
		`SELECT group_id, channel_id FROM channel_group_items
		 WHERE participant_id = $1 ORDER BY position ASC`, participantID)
	if err != nil {
		return nil, err
	}
	defer irows.Close()
	for irows.Next() {
		var groupID, channelID string
		if err := irows.Scan(&groupID, &channelID); err != nil {
			return nil, err
		}
		if i, ok := index[groupID]; ok {
			groups[i].ChannelIDs = append(groups[i].ChannelIDs, channelID)
		}
	}
	return groups, irows.Err()
}

func (s *Store) CreateChannelGroup(ctx context.Context, participantID, name string) (ChannelGroup, error) {
	var g ChannelGroup
	// new group goes to the bottom of this participant's list
	err := s.pool.QueryRow(ctx,
		`INSERT INTO channel_groups (participant_id, name, position)
		 VALUES ($1, $2, COALESCE((SELECT max(position)+1 FROM channel_groups WHERE participant_id = $1), 0))
		 RETURNING id, participant_id, name, position, collapsed, created_at`,
		participantID, name,
	).Scan(&g.ID, &g.ParticipantID, &g.Name, &g.Position, &g.Collapsed, &g.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return g, ErrConflict
		}
		return g, err
	}
	g.ChannelIDs = []string{}
	return g, nil
}

// UpdateChannelGroup changes a group's name, collapsed state, or position. Nil
// fields are left unchanged. Scoped to participantID so one participant cannot
// touch another's groups.
func (s *Store) UpdateChannelGroup(ctx context.Context, participantID, id string, name *string, collapsed *bool, position *int) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE channel_groups SET
		   name = COALESCE($3, name),
		   collapsed = COALESCE($4, collapsed),
		   position = COALESCE($5, position)
		 WHERE participant_id = $1 AND id = $2`,
		participantID, id, name, collapsed, position)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteChannelGroup(ctx context.Context, participantID, id string) error {
	// items cascade via FK; the channels themselves become ungrouped
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM channel_groups WHERE participant_id = $1 AND id = $2`, participantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetChannelGroup places a channel into one of the caller's groups, or removes
// it from any group when groupID is nil. A channel sits in at most one group per
// participant, so this upserts the single placement row.
func (s *Store) SetChannelGroup(ctx context.Context, participantID, channelID string, groupID *string, position int) error {
	if groupID == nil {
		_, err := s.pool.Exec(ctx,
			`DELETE FROM channel_group_items WHERE participant_id = $1 AND channel_id = $2`,
			participantID, channelID)
		return err
	}
	// the group must belong to this participant, or the FK/ownership check fails
	var owned bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channel_groups WHERE id = $1 AND participant_id = $2)`,
		*groupID, participantID).Scan(&owned); err != nil {
		return err
	}
	if !owned {
		return ErrNotFound
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO channel_group_items (participant_id, channel_id, group_id, position)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (participant_id, channel_id)
		 DO UPDATE SET group_id = EXCLUDED.group_id, position = EXCLUDED.position`,
		participantID, channelID, *groupID, position)
	if isForeignKeyViolation(err) {
		return ErrNotFound
	}
	return err
}
