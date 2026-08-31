package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/presmihaylov/agentchat/models"
)

// parseFilters reads the shared search filter params:
// channel (name or id), author (name or id), thread, since, until, has_attachment, limit.
func (s *Server) parseFilters(w http.ResponseWriter, r *http.Request, p models.Participant) (models.SearchFilters, bool) {
	var f models.SearchFilters
	q := r.URL.Query()

	if c := q.Get("channel"); c != "" {
		ch, err := s.resolveChannel(r, p, c)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "unknown channel: "+c)
			return f, false
		}
		f.ChannelID = &ch.ID
	}
	if a := q.Get("author"); a != "" {
		author, err := s.resolveParticipant(r, p, a)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "unknown author: "+a)
			return f, false
		}
		f.AuthorID = &author.ID
	}
	if t := q.Get("thread"); t != "" {
		if !isUUID(t) {
			writeErr(w, http.StatusBadRequest, "thread must be a message id")
			return f, false
		}
		f.ThreadRootID = &t
	}
	for name, dst := range map[string]**time.Time{"since": &f.Since, "until": &f.Until} {
		if v := q.Get(name); v != "" {
			ts, err := time.Parse(time.RFC3339, v)
			if err != nil {
				writeErr(w, http.StatusBadRequest, name+" must be RFC3339")
				return f, false
			}
			*dst = &ts
		}
	}
	if v := q.Get("has_attachment"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "has_attachment must be a boolean")
			return f, false
		}
		f.HasAttachment = &b
	}
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	// always member-scope: search never returns a channel you are not in
	f.MemberID = &p.ID
	return f, true
}

func (s *Server) handleSearchText(w http.ResponseWriter, r *http.Request, p models.Participant) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeErr(w, http.StatusBadRequest, "q is required")
		return
	}
	f, ok := s.parseFilters(w, r, p)
	if !ok {
		return
	}
	results, err := s.store.SearchText(r.Context(), p.RoomID, query, f)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) handleSearchSemantic(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if s.cfg.Embedder == nil {
		writeErr(w, http.StatusServiceUnavailable, "semantic search is disabled (no embeddings provider configured)")
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeErr(w, http.StatusBadRequest, "q is required")
		return
	}
	f, ok := s.parseFilters(w, r, p)
	if !ok {
		return
	}
	vecs, err := s.cfg.Embedder.Embed(r.Context(), []string{query})
	if err != nil {
		writeErr(w, http.StatusBadGateway, "embedding provider error: "+err.Error())
		return
	}
	results, err := s.store.SearchSemantic(r.Context(), p.RoomID, vecs[0], f)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
