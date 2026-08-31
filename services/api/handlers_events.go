package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/presmihaylov/agentchat/models"
)

const (
	maxEventWait  = 30 * time.Second
	eventPollTick = 700 * time.Millisecond
)

// handleEvents returns events after a cursor, long-polling up to wait seconds.
// With no "after" param it returns the current cursor so clients can start tailing.
// Filters: types=a,b limits event types; relevant=true keeps only message
// events that are broadcasts, mention the caller, or belong to threads the
// caller wrote in. The cursor always advances past filtered-out events.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request, p models.Participant) {
	q := r.URL.Query()

	if q.Get("after") == "" {
		seq, err := s.store.LatestSeq(r.Context(), p.RoomID)
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"events": []models.Event{}, "cursor": seq})
		return
	}

	after, err := strconv.ParseInt(q.Get("after"), 10, 64)
	if err != nil || after < 0 {
		writeErr(w, http.StatusBadRequest, "after must be a non-negative integer")
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))

	types := map[string]bool{}
	for _, t := range strings.Split(q.Get("types"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			types[t] = true
		}
	}
	relevant := q.Get("relevant") == "true"

	wait := time.Duration(0)
	if ws := q.Get("wait"); ws != "" {
		sec, err := strconv.Atoi(ws)
		if err != nil || sec < 0 {
			writeErr(w, http.StatusBadRequest, "wait must be seconds")
			return
		}
		wait = min(time.Duration(sec)*time.Second, maxEventWait)
	}

	deadline := time.Now().Add(wait)
	for {
		events, err := s.store.ListEvents(r.Context(), p.RoomID, after, limit)
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		scanned := after
		if len(events) > 0 {
			scanned = events[len(events)-1].Seq
		}
		kept, err := s.filterEvents(r.Context(), events, p, types, relevant)
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		if len(kept) > 0 || time.Now().After(deadline) {
			writeJSON(w, http.StatusOK, map[string]any{"events": kept, "cursor": scanned})
			return
		}
		// everything in this batch was filtered out — advance past it so the
		// long-poll keeps waiting for something relevant instead of returning empty
		after = scanned
		select {
		case <-r.Context().Done():
			return
		case <-time.After(eventPollTick):
		}
	}
}

// eventMessage is the slice of a message payload the relevance filter needs.
type eventMessage struct {
	ID           string   `json:"id"`
	ThreadRootID *string  `json:"thread_root_id"`
	IsBroadcast  bool     `json:"is_broadcast"`
	Mentions     []string `json:"mentions"`
}

func (s *Server) filterEvents(ctx context.Context, events []models.Event, p models.Participant, types map[string]bool, relevant bool) ([]models.Event, error) {
	if len(types) == 0 && !relevant {
		return events, nil
	}

	kept := []models.Event{}
	// message events whose fate depends on thread participation, keyed by root
	pending := map[string][]models.Event{}
	rootIDs := []string{}

	for _, e := range events {
		if len(types) > 0 && !types[e.Type] {
			continue
		}
		if !relevant {
			kept = append(kept, e)
			continue
		}
		// relevant=true only ever passes message payloads — other types carry
		// no addressing info to judge relevance by
		if e.Type != "message.created" && e.Type != "message.edited" {
			continue
		}
		var m eventMessage
		if err := json.Unmarshal(e.Payload, &m); err != nil {
			continue
		}
		if m.IsBroadcast || slices.Contains(m.Mentions, p.Name) {
			kept = append(kept, e)
			continue
		}
		if m.ThreadRootID != nil {
			if _, seen := pending[*m.ThreadRootID]; !seen {
				rootIDs = append(rootIDs, *m.ThreadRootID)
			}
			pending[*m.ThreadRootID] = append(pending[*m.ThreadRootID], e)
		}
	}

	if len(rootIDs) > 0 {
		mine, err := s.store.ParticipatedThreadRoots(ctx, p.RoomID, p.ID, rootIDs)
		if err != nil {
			return nil, err
		}
		for root, evs := range pending {
			if mine[root] {
				kept = append(kept, evs...)
			}
		}
		// participation check regroups by thread — restore log order
		slices.SortFunc(kept, func(a, b models.Event) int { return int(a.Seq - b.Seq) })
	}
	return kept, nil
}
