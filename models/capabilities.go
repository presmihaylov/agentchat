package models

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Capability limits: per agent, and per schema/args/result blob.
const (
	CapabilityMaxPerAgent = 50
	CapabilityMaxSchema   = 16 * 1024
	CapabilityMaxArgs     = 64 * 1024
	CapabilityMaxResult   = 256 * 1024
	// CapabilityMaxPending bounds the in-flight calls one agent has to answer.
	CapabilityMaxPending = 8
	// CapabilityCallPruneAfter is how long finished calls are kept.
	CapabilityCallPruneAfter = 7 * 24 * time.Hour
)

var (
	ErrAgentOffline    = errors.New("that agent is offline: its capabilities are not callable")
	ErrCallFinished    = errors.New("that call already finished")
	ErrTooManyCalls    = errors.New("that agent has too many pending calls")
	ErrNotTarget       = errors.New("only the called agent can answer this call")
	ErrSelfCall        = errors.New("an agent cannot call itself")
	ErrCapabilityQuota = errors.New("too many capabilities for one agent")
)

// Capability is one typed thing an agent says it can do.
type Capability struct {
	ID              string          `json:"id"`
	ParticipantID   string          `json:"participant_id"`
	ParticipantName string          `json:"participant_name"`
	Online          bool            `json:"online"`
	Name            string          `json:"name"`
	Description     string          `json:"description"`
	InputSchema     json.RawMessage `json:"inputSchema"`
	OutputSchema    json.RawMessage `json:"outputSchema,omitempty"`
	UpdatedAt       time.Time       `json:"updated_at"`
}

// CapabilityInput is what an agent registers.
type CapabilityInput struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
}

// Call states.
const (
	CallPending = "pending"
	CallDone    = "done"
	CallError   = "error"
	CallTimeout = "timeout"
)

// CapabilityCall is one routed invocation.
type CapabilityCall struct {
	ID           string          `json:"call_id"`
	CapabilityID *string         `json:"capability_id,omitempty"`
	Name         string          `json:"name"`
	TargetID     string          `json:"target_id"`
	TargetName   string          `json:"target_name"`
	CallerID     string          `json:"caller_id"`
	CallerName   string          `json:"caller_name"`
	Args         json.RawMessage `json:"args"`
	State        string          `json:"state"`
	Result       json.RawMessage `json:"result,omitempty"`
	Error        *string         `json:"error,omitempty"`
	TimeoutSecs  int             `json:"timeout_seconds"`
	ExpiresAt    time.Time       `json:"expires_at"`
	CreatedAt    time.Time       `json:"created_at"`
	FinishedAt   *time.Time      `json:"finished_at,omitempty"`
}

const capabilityColumns = `c.id, c.participant_id, p.name, p.last_seen_at > now() - $1::interval, c.name, c.description, c.input_schema, c.output_schema, c.updated_at`

func scanCapability(row pgx.Row, c *Capability) error {
	return row.Scan(&c.ID, &c.ParticipantID, &c.ParticipantName, &c.Online, &c.Name, &c.Description, &c.InputSchema, &c.OutputSchema, &c.UpdatedAt)
}

func (s *Store) queryCapabilities(ctx context.Context, where string, args ...any) ([]Capability, error) {
	args = append([]any{OnlineWindow.String()}, args...)
	rows, err := s.pool.Query(ctx,
		`SELECT `+capabilityColumns+` FROM capabilities c JOIN participants p ON p.id = c.participant_id
		 WHERE `+where+` ORDER BY p.name, c.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Capability{}
	for rows.Next() {
		var c Capability
		if err := scanCapability(rows, &c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpsertCapabilities registers the agent's capabilities: with replace the
// listed set becomes the whole set, otherwise names not listed are kept.
// Emits capability.registered with the resulting names. The owner is always
// the given participant: there is no way to register for someone else.
func (s *Store) UpsertCapabilities(ctx context.Context, roomID, participantID string, caps []CapabilityInput, replace bool) ([]Capability, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return nil, err
	}
	if replace {
		names := make([]string, 0, len(caps))
		for _, c := range caps {
			names = append(names, c.Name)
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM capabilities WHERE participant_id = $1 AND NOT (name = ANY($2::text[]))`,
			participantID, names); err != nil {
			return nil, err
		}
	}
	for _, c := range caps {
		var out json.RawMessage
		if len(c.OutputSchema) > 0 {
			out = c.OutputSchema
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO capabilities (room_id, participant_id, name, description, input_schema, output_schema)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (participant_id, name) DO UPDATE SET
			   description = EXCLUDED.description, input_schema = EXCLUDED.input_schema,
			   output_schema = EXCLUDED.output_schema, updated_at = now()`,
			roomID, participantID, c.Name, c.Description, c.InputSchema, out); err != nil {
			return nil, err
		}
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM capabilities WHERE participant_id = $1`, participantID).Scan(&n); err != nil {
		return nil, err
	}
	if n > CapabilityMaxPerAgent {
		return nil, ErrCapabilityQuota
	}
	if err := s.emitRegisteredTx(ctx, tx, roomID, participantID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.ListCapabilities(ctx, roomID, participantID)
}

// DeleteCapability removes one by name. ErrNotFound when the agent has none by that name.
func (s *Store) DeleteCapability(ctx context.Context, roomID, participantID, name string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM capabilities WHERE participant_id = $1 AND name = $2`, participantID, name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := s.emitRegisteredTx(ctx, tx, roomID, participantID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) emitRegisteredTx(ctx context.Context, tx pgx.Tx, roomID, participantID string) error {
	var name string
	var names []string
	if err := tx.QueryRow(ctx,
		`SELECT p.name, COALESCE((SELECT array_agg(c.name ORDER BY c.name) FROM capabilities c WHERE c.participant_id = p.id), '{}')
		 FROM participants p WHERE p.id = $1`, participantID).Scan(&name, &names); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"participant_id": participantID, "participant_name": name, "names": names})
	return appendEventTx(ctx, tx, roomID, "capability.registered", payload)
}

// ListCapabilities is one agent's registry.
func (s *Store) ListCapabilities(ctx context.Context, roomID, participantID string) ([]Capability, error) {
	return s.queryCapabilities(ctx, `c.room_id = $2 AND c.participant_id = $3`, roomID, participantID)
}

// ListRoomCapabilities is every callable capability in the workspace: online
// agents only, unless includeOffline (the entries then carry online=false).
func (s *Store) ListRoomCapabilities(ctx context.Context, roomID string, includeOffline bool) ([]Capability, error) {
	where := `c.room_id = $2 AND NOT p.revoked`
	if !includeOffline {
		where += ` AND p.last_seen_at > now() - $1::interval`
	}
	return s.queryCapabilities(ctx, where, roomID)
}

// CreateCallParams: the caller's own room is the only place the target is
// looked up, so a call can never leave its workspace.
type CreateCallParams struct {
	RoomID      string
	CallerID    string
	TargetID    string
	Name        string
	Args        json.RawMessage
	TimeoutSecs int
}

const callColumns = `k.id, k.capability_id, k.name, k.target_id, t.name, k.caller_id, ca.name, k.args, k.state, k.result, k.error, k.timeout_secs, k.expires_at, k.created_at, k.finished_at`

func scanCall(row pgx.Row, c *CapabilityCall) error {
	return row.Scan(&c.ID, &c.CapabilityID, &c.Name, &c.TargetID, &c.TargetName, &c.CallerID, &c.CallerName, &c.Args, &c.State, &c.Result, &c.Error, &c.TimeoutSecs, &c.ExpiresAt, &c.CreatedAt, &c.FinishedAt)
}

// CreateCall routes one invocation: the target must be an online agent of
// the same room with that capability and fewer than CapabilityMaxPending
// open calls. The row, the capability.call event and the target's delivery
// receipt are one transaction.
func (s *Store) CreateCall(ctx context.Context, p CreateCallParams) (CapabilityCall, error) {
	if p.CallerID == p.TargetID {
		return CapabilityCall{}, ErrSelfCall
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CapabilityCall{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, p.RoomID); err != nil {
		return CapabilityCall{}, err
	}
	var targetName, callerName string
	var online bool
	err = tx.QueryRow(ctx,
		`SELECT t.name, t.last_seen_at > now() - $3::interval, ca.name
		 FROM participants t, participants ca
		 WHERE t.id = $1 AND t.room_id = $2 AND NOT t.is_human AND NOT t.revoked
		   AND ca.id = $4 AND ca.room_id = $2`,
		p.TargetID, p.RoomID, OnlineWindow.String(), p.CallerID).Scan(&targetName, &online, &callerName)
	if err != nil {
		return CapabilityCall{}, mapRowErr(err)
	}
	if !online {
		return CapabilityCall{}, ErrAgentOffline
	}
	var capID string
	if err := tx.QueryRow(ctx, `SELECT id FROM capabilities WHERE participant_id = $1 AND name = $2`,
		p.TargetID, p.Name).Scan(&capID); err != nil {
		return CapabilityCall{}, mapRowErr(err)
	}
	var pending int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM capability_calls WHERE target_id = $1 AND state = 'pending' AND expires_at > now()`,
		p.TargetID).Scan(&pending); err != nil {
		return CapabilityCall{}, err
	}
	if pending >= CapabilityMaxPending {
		return CapabilityCall{}, ErrTooManyCalls
	}
	var c CapabilityCall
	err = scanCall(tx.QueryRow(ctx,
		`WITH k AS (
		   INSERT INTO capability_calls (room_id, capability_id, name, target_id, caller_id, args, timeout_secs, expires_at)
		   VALUES ($1, $2, $3, $4, $5, $6, $7::int, now() + make_interval(secs => $7::int))
		   RETURNING *)
		 SELECT `+callColumns+` FROM k JOIN participants t ON t.id = k.target_id JOIN participants ca ON ca.id = k.caller_id`,
		p.RoomID, capID, p.Name, p.TargetID, p.CallerID, p.Args, p.TimeoutSecs), &c)
	if err != nil {
		return CapabilityCall{}, err
	}
	payload, _ := json.Marshal(map[string]any{
		"call_id": c.ID, "capability_id": capID, "name": c.Name,
		"target_id": c.TargetID, "target_name": c.TargetName,
		"caller_id": c.CallerID, "caller_name": c.CallerName,
		"args": c.Args, "timeout_seconds": c.TimeoutSecs, "expires_at": c.ExpiresAt,
	})
	seq, err := appendEventSeqTx(ctx, tx, p.RoomID, "capability.call", payload)
	if err != nil {
		return CapabilityCall{}, err
	}
	// the target is online by the check above, so the receipt starts accepted
	if _, err := tx.Exec(ctx,
		`INSERT INTO deliveries (room_id, event_seq, recipient_id, state) VALUES ($1, $2, $3, 'accepted')`,
		p.RoomID, seq, p.TargetID); err != nil {
		return CapabilityCall{}, err
	}
	return c, tx.Commit(ctx)
}

// FinishCall records the target's answer: exactly one of result or errMsg.
// Only the target may answer, only once, and only while the call is pending.
func (s *Store) FinishCall(ctx context.Context, roomID, callID, byID string, result json.RawMessage, errMsg *string) (CapabilityCall, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CapabilityCall{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockRoomEvents(ctx, tx, roomID); err != nil {
		return CapabilityCall{}, err
	}
	var targetID, state string
	if err := tx.QueryRow(ctx, `SELECT target_id, state FROM capability_calls WHERE id = $1 AND room_id = $2 FOR UPDATE`,
		callID, roomID).Scan(&targetID, &state); err != nil {
		return CapabilityCall{}, mapRowErr(err)
	}
	if targetID != byID {
		return CapabilityCall{}, ErrNotTarget
	}
	if state != CallPending {
		return CapabilityCall{}, ErrCallFinished
	}
	newState := CallDone
	if errMsg != nil {
		newState = CallError
		result = nil
	}
	var c CapabilityCall
	err = scanCall(tx.QueryRow(ctx,
		`WITH k AS (
		   UPDATE capability_calls SET state = $3, result = $4, error = $5, finished_at = now() WHERE id = $1 AND room_id = $2
		   RETURNING *)
		 SELECT `+callColumns+` FROM k JOIN participants t ON t.id = k.target_id JOIN participants ca ON ca.id = k.caller_id`,
		callID, roomID, newState, result, errMsg), &c)
	if err != nil {
		return CapabilityCall{}, err
	}
	payload, _ := json.Marshal(map[string]any{
		"call_id": c.ID, "name": c.Name, "target_id": c.TargetID, "target_name": c.TargetName,
		"caller_id": c.CallerID, "caller_name": c.CallerName, "state": c.State,
		"result": c.Result, "error": c.Error,
	})
	if err := appendEventTx(ctx, tx, roomID, "capability.result", payload); err != nil {
		return CapabilityCall{}, err
	}
	return c, tx.Commit(ctx)
}

// GetCall returns one call of the room.
func (s *Store) GetCall(ctx context.Context, roomID, callID string) (CapabilityCall, error) {
	var c CapabilityCall
	err := scanCall(s.pool.QueryRow(ctx,
		`SELECT `+callColumns+` FROM capability_calls k JOIN participants t ON t.id = k.target_id JOIN participants ca ON ca.id = k.caller_id
		 WHERE k.id = $1 AND k.room_id = $2`, callID, roomID), &c)
	return c, mapRowErr(err)
}

// WaitCall polls until the call leaves pending or its expiry passes, then
// returns it; an overdue call is flipped to timeout here so the caller never
// waits on the sweeper.
func (s *Store) WaitCall(ctx context.Context, roomID, callID string, tick time.Duration) (CapabilityCall, error) {
	for {
		c, err := s.GetCall(ctx, roomID, callID)
		if err != nil {
			return c, err
		}
		if c.State != CallPending {
			return c, nil
		}
		if !time.Now().Before(c.ExpiresAt) {
			if err := s.timeoutCalls(ctx, callID); err != nil {
				return c, err
			}
			return s.GetCall(ctx, roomID, callID)
		}
		wait := min(tick, time.Until(c.ExpiresAt))
		select {
		case <-ctx.Done():
			return c, ctx.Err()
		case <-time.After(wait):
		}
	}
}

func (s *Store) timeoutCalls(ctx context.Context, onlyID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE capability_calls SET state = 'timeout', finished_at = now()
		 WHERE state = 'pending' AND expires_at <= now() AND (NULLIF($1::text, '') IS NULL OR id = NULLIF($1::text, '')::uuid)`, onlyID)
	return err
}

// SweepCalls flips overdue pending calls to timeout and prunes finished
// calls past CapabilityCallPruneAfter. Runs on the presence ticker.
func (s *Store) SweepCalls(ctx context.Context) error {
	if err := s.timeoutCalls(ctx, ""); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx,
		`DELETE FROM capability_calls WHERE state <> 'pending' AND finished_at < now() - $1::interval`,
		CapabilityCallPruneAfter.String())
	return err
}
