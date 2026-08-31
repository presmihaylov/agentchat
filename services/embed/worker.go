package embed

import (
	"context"
	"log/slog"
	"time"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/services/api"
)

const (
	pollInterval = 2 * time.Second
	batchSize    = 50
)

// Worker drains the message embedding outbox in the background.
type Worker struct {
	store    *models.Store
	embedder api.Embedder
}

func NewWorker(store *models.Store, embedder api.Embedder) *Worker {
	return &Worker{store: store, embedder: embedder}
}

// Run blocks until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	if err := w.store.ResetStaleEmbeddings(ctx); err != nil {
		slog.Error("embed: reset stale", "err", err)
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	lastReset := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if time.Since(lastReset) > time.Minute {
				lastReset = time.Now()
				if err := w.store.ResetStaleEmbeddings(ctx); err != nil {
					slog.Error("embed: reset stale", "err", err)
				}
			}
			// drain everything currently pending before sleeping again
			for w.processBatch(ctx) {
			}
		}
	}
}

func (w *Worker) processBatch(ctx context.Context) bool {
	claimed, err := w.store.ClaimPendingEmbeddings(ctx, batchSize)
	if err != nil {
		slog.Error("embed: claim", "err", err)
		return false
	}
	if len(claimed) == 0 {
		return false
	}

	texts := make([]string, len(claimed))
	ids := make([]string, len(claimed))
	for i, c := range claimed {
		texts[i] = c.Body
		ids[i] = c.ID
	}

	vecs, err := w.embedder.Embed(ctx, texts)
	if err != nil {
		slog.Error("embed: provider", "err", err, "count", len(claimed))
		// A single poison message must not burn attempts for the whole batch:
		// retry one by one so only the actual offender accrues failures.
		if len(claimed) > 1 {
			w.processIndividually(ctx, claimed)
			return true
		}
		if err := w.store.ReleaseEmbeddings(ctx, ids); err != nil {
			slog.Error("embed: release", "err", err)
		}
		return false
	}

	failed := []string{}
	for i, id := range ids {
		if err := w.store.SaveEmbedding(ctx, id, vecs[i]); err != nil {
			slog.Error("embed: save", "err", err, "message_id", id)
			failed = append(failed, id)
		}
	}
	if err := w.store.ReleaseEmbeddings(ctx, failed); err != nil {
		slog.Error("embed: release failed", "err", err)
	}
	return len(claimed) == batchSize
}

func (w *Worker) processIndividually(ctx context.Context, claimed []models.PendingMessage) {
	for _, c := range claimed {
		vecs, err := w.embedder.Embed(ctx, []string{c.Body})
		if err != nil || len(vecs) != 1 {
			slog.Error("embed: provider (single)", "err", err, "message_id", c.ID)
			if err := w.store.ReleaseEmbeddings(ctx, []string{c.ID}); err != nil {
				slog.Error("embed: release", "err", err)
			}
			continue
		}
		if err := w.store.SaveEmbedding(ctx, c.ID, vecs[0]); err != nil {
			slog.Error("embed: save", "err", err, "message_id", c.ID)
			if err := w.store.ReleaseEmbeddings(ctx, []string{c.ID}); err != nil {
				slog.Error("embed: release", "err", err)
			}
		}
	}
}
