package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/presmihaylov/agentchat/models"
)

const (
	maxEventWait  = 30 * time.Second
	eventPollTick = 700 * time.Millisecond
)

// handleEvents returns events after a cursor, long-polling up to wait seconds.
// With no "after" param it returns the current cursor so clients can start tailing.
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
		if len(events) > 0 || time.Now().After(deadline) {
			cursor := after
			if len(events) > 0 {
				cursor = events[len(events)-1].Seq
			}
			writeJSON(w, http.StatusOK, map[string]any{"events": events, "cursor": cursor})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(eventPollTick):
		}
	}
}
