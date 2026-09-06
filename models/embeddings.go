package models

import (
	"context"

	"github.com/pgvector/pgvector-go"
)

type PendingMessage struct {
	ID   string
	Body string
}

const maxEmbedAttempts = 5

// ClaimPendingEmbeddings atomically claims up to limit messages for embedding.
// Claimed rows move to 'inflight'; crash recovery is ResetStaleEmbeddings.
func (s *Store) ClaimPendingEmbeddings(ctx context.Context, limit int) ([]PendingMessage, error) {
	rows, err := s.pool.Query(ctx,
		`UPDATE messages SET embed_status = 'inflight', embed_attempts = embed_attempts + 1,
		        embed_claimed_at = now()
		 WHERE id IN (
		     SELECT id FROM messages WHERE embed_status = 'pending'
		     ORDER BY created_at ASC LIMIT $1
		     FOR UPDATE SKIP LOCKED)
		 RETURNING id, body`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PendingMessage{}
	for rows.Next() {
		var p PendingMessage
		if err := rows.Scan(&p.ID, &p.Body); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) SaveEmbedding(ctx context.Context, messageID string, embedding []float32) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Guard on 'inflight': an edit re-queues the message as 'pending' and this
	// vector is for the old body — drop it and let the next pass re-embed.
	res, err := tx.Exec(ctx,
		`UPDATE messages SET embed_status = 'done' WHERE id = $1 AND embed_status = 'inflight'`,
		messageID)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return nil
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO message_embeddings (message_id, embedding) VALUES ($1, $2)
		 ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
		messageID, pgvector.NewVector(embedding))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReleaseEmbeddings returns claimed messages to the queue, or marks them
// permanently failed after too many attempts.
func (s *Store) ReleaseEmbeddings(ctx context.Context, messageIDs []string) error {
	if len(messageIDs) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE messages SET embed_status = CASE
		     WHEN embed_attempts >= $2 THEN 'failed' ELSE 'pending' END
		 WHERE id = ANY($1) AND embed_status = 'inflight'`,
		messageIDs, maxEmbedAttempts)
	return err
}

// RequeueFailedEmbeddings gives exhausted rows another cycle after a cool-down,
// so a transient provider outage never permanently drops messages from semantic
// search. A true poison message just retries slowly (5 attempts per ~15 min).
func (s *Store) RequeueFailedEmbeddings(ctx context.Context) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE messages SET embed_status = 'pending', embed_attempts = 0
		 WHERE embed_status = 'failed'
		   AND embed_claimed_at < now() - interval '15 minutes'`)
	return err
}

// ResetStaleEmbeddings requeues rows stuck 'inflight' for over 5 minutes
// (crashed worker). The age filter keeps one instance's startup from stealing
// another live instance's freshly claimed batch.
func (s *Store) ResetStaleEmbeddings(ctx context.Context) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE messages SET embed_status = 'pending'
		 WHERE embed_status = 'inflight'
		   AND (embed_claimed_at IS NULL OR embed_claimed_at < now() - interval '5 minutes')`)
	return err
}

// PutEmbedding writes a vector regardless of queue state and marks the row
// done. For tests and repair tools; the worker path is SaveEmbedding.
func (s *Store) PutEmbedding(ctx context.Context, messageID string, embedding []float32) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE messages SET embed_status = 'done' WHERE id = $1`, messageID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO message_embeddings (message_id, embedding) VALUES ($1, $2)
		 ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
		messageID, pgvector.NewVector(embedding))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
