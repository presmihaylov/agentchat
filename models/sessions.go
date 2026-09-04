package models

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const sessionColumns = `s.id, s.user_id, s.provider, s.created_at, s.last_used_at, s.expires_at`

// CreateSession stores a login. expires_at slides by ttl on use but never past
// SessionMaxAge after creation.
func (s *Store) CreateSession(ctx context.Context, userID, provider string, tokenHash []byte, ttl time.Duration) (Session, error) {
	var sess Session
	err := s.pool.QueryRow(ctx,
		`INSERT INTO sessions AS s (user_id, provider, token_hash, expires_at)
		 VALUES ($1, $2, $3, now() + LEAST($4::interval, $5::interval))
		 RETURNING `+sessionColumns,
		userID, provider, tokenHash, ttl.String(), SessionMaxAge.String(),
	).Scan(&sess.ID, &sess.UserID, &sess.Provider, &sess.CreatedAt, &sess.LastUsedAt, &sess.ExpiresAt)
	return sess, err
}

// SessionByTokenHash authenticates a ses_ request and returns its user. A live
// session is one that is neither idle-expired nor older than SessionMaxAge.
// The same statement refreshes last_used_at and slides expires_at, but only
// once per SessionTouchEvery so the hot path stays a read most of the time.
// The outer SELECT cannot see the CTE's write, so it takes the returned
// values when there are any.
func (s *Store) SessionByTokenHash(ctx context.Context, tokenHash []byte, ttl time.Duration) (Session, User, error) {
	var sess Session
	var u User
	err := s.pool.QueryRow(ctx,
		`WITH touched AS (
		     UPDATE sessions SET last_used_at = now(),
		            expires_at = LEAST(now() + $2::interval, created_at + $3::interval)
		     WHERE token_hash = $1 AND expires_at > now()
		       AND created_at > now() - $3::interval
		       AND last_used_at < now() - $4::interval
		     RETURNING id, last_used_at, expires_at
		 )
		 SELECT s.id, s.user_id, s.provider, s.created_at,
		        COALESCE(t.last_used_at, s.last_used_at), COALESCE(t.expires_at, s.expires_at),
		        `+userColumns+`
		 FROM sessions s JOIN users u ON u.id = s.user_id
		 LEFT JOIN touched t ON t.id = s.id
		 WHERE s.token_hash = $1 AND s.expires_at > now() AND s.created_at > now() - $3::interval`,
		tokenHash, ttl.String(), SessionMaxAge.String(), SessionTouchEvery.String(),
	).Scan(&sess.ID, &sess.UserID, &sess.Provider, &sess.CreatedAt, &sess.LastUsedAt, &sess.ExpiresAt,
		&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.MustChangePassword, &u.LastActiveWorkspaceID, &u.CreatedAt)
	return sess, u, mapRowErr(err)
}

// DeleteSession logs one token out. Deleting a missing row is not an error.
func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

// DeleteUserSessions logs a user out everywhere except the session whose hash
// is keepHash (nil keeps none).
func (s *Store) DeleteUserSessions(ctx context.Context, userID string, keepHash []byte) (int64, error) {
	return deleteUserSessions(ctx, s.pool, userID, keepHash)
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

var _ execer = pgx.Tx(nil)

func deleteUserSessions(ctx context.Context, db execer, userID string, keepHash []byte) (int64, error) {
	res, err := db.Exec(ctx,
		`DELETE FROM sessions WHERE user_id = $1 AND ($2::bytea IS NULL OR token_hash <> $2)`,
		userID, keepHash)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected(), nil
}

// SweepSessions drops rows no request can use any more.
func (s *Store) SweepSessions(ctx context.Context) (int64, error) {
	res, err := s.pool.Exec(ctx,
		`DELETE FROM sessions WHERE expires_at <= now() OR created_at <= now() - $1::interval`,
		SessionMaxAge.String())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected(), nil
}

// AgeSession is a test hook: moves a session's created_at and last_used_at
// back by age so cap and touch behavior can be observed without waiting.
func (s *Store) AgeSession(ctx context.Context, tokenHash []byte, age time.Duration) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sessions SET created_at = created_at - $2::interval, last_used_at = last_used_at - $2::interval
		 WHERE token_hash = $1`, tokenHash, age.String())
	return err
}

// ExpireSession is a test hook: idle-expires a session while created_at stays
// inside the cap, so the expires_at predicate can be observed.
func (s *Store) ExpireSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, tokenHash)
	return err
}
