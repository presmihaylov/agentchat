package models

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/pgvector/pgvector-go"
)

func filterClause(f SearchFilters, args *[]any) string {
	clause := ""
	add := func(cond string, val any) {
		*args = append(*args, val)
		clause += " AND " + fmt.Sprintf(cond, len(*args))
	}
	if f.ChannelID != nil {
		add("m.channel_id = $%d", *f.ChannelID)
	}
	if f.AuthorID != nil {
		add("m.author_id = $%d", *f.AuthorID)
	}
	if f.ThreadRootID != nil {
		*args = append(*args, *f.ThreadRootID)
		n := len(*args)
		clause += fmt.Sprintf(" AND (m.thread_root_id = $%d OR m.id = $%d)", n, n)
	}
	if f.Since != nil {
		add("m.created_at >= $%d", *f.Since)
	}
	if f.Until != nil {
		add("m.created_at <= $%d", *f.Until)
	}
	if f.HasAttachment != nil {
		add("EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.message_id = m.id) = $%d", *f.HasAttachment)
	}
	return clause
}

func searchLimit(f SearchFilters) int {
	if f.Limit <= 0 || f.Limit > 100 {
		return 20
	}
	return f.Limit
}

// SearchText runs full-text search over a room's messages.
func (s *Store) SearchText(ctx context.Context, roomID, query string, f SearchFilters) ([]SearchResult, error) {
	args := []any{roomID, query}
	clause := filterClause(f, &args)
	args = append(args, searchLimit(f))

	sql := "SELECT" + messageColumns +
		`, ts_rank(m.tsv, websearch_to_tsquery('english', $2)) AS score` +
		messageFrom + fmt.Sprintf(`
		 WHERE m.room_id = $1 AND m.tsv @@ websearch_to_tsquery('english', $2)%s
		 ORDER BY score DESC, m.created_at DESC LIMIT $%d`, clause, len(args))

	return s.runSearch(ctx, sql, args)
}

// SearchSemantic runs cosine-similarity search over message embeddings.
func (s *Store) SearchSemantic(ctx context.Context, roomID string, embedding []float32, f SearchFilters) ([]SearchResult, error) {
	args := []any{roomID, pgvector.NewVector(embedding)}
	clause := filterClause(f, &args)
	args = append(args, searchLimit(f))

	sql := "SELECT" + messageColumns +
		`, 1 - (e.embedding <=> $2) AS score` +
		messageFrom + fmt.Sprintf(`
		 JOIN message_embeddings e ON e.message_id = m.id
		 WHERE m.room_id = $1%s
		 ORDER BY e.embedding <=> $2 ASC LIMIT $%d`, clause, len(args))

	return s.runSearch(ctx, sql, args)
}

func (s *Store) runSearch(ctx context.Context, sql string, args []any) ([]SearchResult, error) {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SearchResult{}
	for rows.Next() {
		r, err := scanSearchResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func scanSearchResult(rows pgx.Rows) (SearchResult, error) {
	var r SearchResult
	// same order as scanMessage plus trailing score
	var attJSON, menJSON []byte
	err := rows.Scan(&r.ID, &r.RoomID, &r.ChannelID, &r.ThreadRootID, &r.AuthorID, &r.AuthorName,
		&r.Body, &r.IsBroadcast, &r.CreatedAt, &r.ReplyCount, &attJSON, &menJSON, &r.Score)
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal(attJSON, &r.Attachments); err != nil {
		return r, err
	}
	return r, json.Unmarshal(menJSON, &r.Mentions)
}
