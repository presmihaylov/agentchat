package models

import "context"

// ListChannelLayout returns a participant's whole sidebar: the named sections
// with the channels placed in each, plus the default section (the channels in
// no named section, which carry a NULL group_id) and its collapsed flag.
// Ordered by group position then item position. The layout is personal, so this
// is scoped to participantID and never leaks another's.
func (s *Store) ListChannelLayout(ctx context.Context, participantID string) (ChannelLayout, error) {
	layout := ChannelLayout{Groups: []ChannelGroup{}, Ungrouped: []string{}}
	if err := s.pool.QueryRow(ctx,
		`SELECT default_section_collapsed FROM participants WHERE id = $1`,
		participantID).Scan(&layout.DefaultCollapsed); err != nil {
		return layout, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, participant_id, name, position, collapsed, created_at
		 FROM channel_groups WHERE participant_id = $1
		 ORDER BY position ASC, created_at ASC`, participantID)
	if err != nil {
		return layout, err
	}
	defer rows.Close()

	index := map[string]int{}
	for rows.Next() {
		var g ChannelGroup
		if err := rows.Scan(&g.ID, &g.ParticipantID, &g.Name, &g.Position, &g.Collapsed, &g.CreatedAt); err != nil {
			return layout, err
		}
		g.ChannelIDs = []string{}
		index[g.ID] = len(layout.Groups)
		layout.Groups = append(layout.Groups, g)
	}
	if err := rows.Err(); err != nil {
		return layout, err
	}

	// second pass: attach the placed channels in order. A NULL group_id is the
	// default section, so those rows land in Ungrouped instead of a group.
	irows, err := s.pool.Query(ctx,
		`SELECT group_id, channel_id FROM channel_group_items
		 WHERE participant_id = $1 ORDER BY position ASC`, participantID)
	if err != nil {
		return layout, err
	}
	defer irows.Close()
	for irows.Next() {
		var groupID *string
		var channelID string
		if err := irows.Scan(&groupID, &channelID); err != nil {
			return layout, err
		}
		if groupID == nil {
			layout.Ungrouped = append(layout.Ungrouped, channelID)
			continue
		}
		if i, ok := index[*groupID]; ok {
			layout.Groups[i].ChannelIDs = append(layout.Groups[i].ChannelIDs, channelID)
		}
	}
	return layout, irows.Err()
}

// SetDefaultSectionCollapsed stores the collapsed flag of the default section.
// It lives on the participant because that section has no row of its own.
func (s *Store) SetDefaultSectionCollapsed(ctx context.Context, participantID string, collapsed bool) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE participants SET default_section_collapsed = $2 WHERE id = $1`, participantID, collapsed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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

// DeleteChannelGroup removes a section and drops its channels into the default
// section, appended after the placement rows already there and keeping their own
// order. Letting the FK cascade instead would throw those rows away.
func (s *Store) DeleteChannelGroup(ctx context.Context, participantID, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var base int
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(max(position)+1, 0) FROM channel_group_items
		 WHERE participant_id = $1 AND group_id IS NULL`, participantID).Scan(&base); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE channel_group_items i SET group_id = NULL,
		   position = $3 + (SELECT count(*) FROM channel_group_items j
		                    WHERE j.participant_id = i.participant_id AND j.group_id = i.group_id
		                      AND j.position < i.position)
		 WHERE i.participant_id = $1 AND i.group_id = $2`, participantID, id, base); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM channel_groups WHERE participant_id = $1 AND id = $2`, participantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// SetChannelGroup places a channel into one of the caller's groups, or into the
// default section when groupID is nil. A channel sits in at most one section per
// participant, so this upserts the single placement row. The default section
// stores a row too (with a NULL group_id), which is what gives it an order.
func (s *Store) SetChannelGroup(ctx context.Context, participantID, channelID string, groupID *string, position int) error {
	if groupID == nil {
		_, err := s.pool.Exec(ctx,
			`INSERT INTO channel_group_items (participant_id, channel_id, group_id, position)
			 VALUES ($1, $2, NULL, $3)
			 ON CONFLICT (participant_id, channel_id)
			 DO UPDATE SET group_id = NULL, position = EXCLUDED.position`,
			participantID, channelID, position)
		if isForeignKeyViolation(err) {
			return ErrNotFound
		}
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
