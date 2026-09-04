package models

import (
	"context"
	"fmt"
)

const userColumns = `u.id, u.username, u.display_name, u.email, u.must_change_password, u.created_at`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.MustChangePassword, &u.CreatedAt)
	return u, mapRowErr(err)
}

func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users u WHERE u.id = $1`, id))
}

// UserByIdentity resolves a (provider, subject) pair to its account. Task 01
// only knows the password provider, whose identity Register created, so a
// miss is a plain ErrNotFound; later providers create the user here.
func (s *Store) UserByIdentity(ctx context.Context, provider, subject string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userColumns+`
		 FROM user_identities i JOIN users u ON u.id = i.user_id
		 WHERE i.provider = $1 AND i.subject = $2`, provider, subject))
}

// PasswordIdentity returns the account id and bcrypt hash behind a username.
func (s *Store) PasswordIdentity(ctx context.Context, username string) (userID string, hash []byte, err error) {
	var h string
	err = s.pool.QueryRow(ctx,
		`SELECT user_id, password_hash FROM user_identities WHERE provider = 'password' AND subject = $1`,
		username).Scan(&userID, &h)
	return userID, []byte(h), mapRowErr(err)
}

// CreatePasswordUser inserts the account and its password identity in one
// transaction; ErrConflict when the username is taken.
func (s *Store) CreatePasswordUser(ctx context.Context, username, displayName string, hash []byte) (User, error) {
	var u User
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return u, err
	}
	defer tx.Rollback(ctx)

	u, err = scanUser(tx.QueryRow(ctx,
		`INSERT INTO users AS u (username, display_name) VALUES ($1, $2) RETURNING `+userColumns,
		username, displayName))
	if err != nil {
		if isUniqueViolation(err) {
			return u, fmt.Errorf("username %q is taken: %w", username, ErrConflict)
		}
		return u, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO user_identities (user_id, provider, subject, password_hash, password_changed_at)
		 VALUES ($1, 'password', $2, $3, now())`, u.ID, username, string(hash)); err != nil {
		return u, err
	}
	return u, tx.Commit(ctx)
}

// SetPasswordHash replaces the password, clears must_change_password and logs
// the user out everywhere except keepSessionHash (nil keeps none), all in one
// transaction so a new password never leaves old sessions alive. Returns the
// number of sessions revoked.
func (s *Store) SetPasswordHash(ctx context.Context, userID string, hash []byte, keepSessionHash []byte) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	res, err := tx.Exec(ctx,
		`UPDATE user_identities SET password_hash = $2, password_changed_at = now()
		 WHERE user_id = $1 AND provider = 'password'`, userID, string(hash))
	if err != nil {
		return 0, err
	}
	if res.RowsAffected() == 0 {
		return 0, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET must_change_password = FALSE WHERE id = $1`, userID); err != nil {
		return 0, err
	}
	n, err := deleteUserSessions(ctx, tx, userID, keepSessionHash)
	if err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}

// SetMustChangePassword flags the account so the next login prompts for a new password.
func (s *Store) SetMustChangePassword(ctx context.Context, userID string, must bool) error {
	res, err := s.pool.Exec(ctx, `UPDATE users SET must_change_password = $2 WHERE id = $1`, userID, must)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
