package api

import (
	"net/http"
	"strings"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/pkg/secrets"
)

type createRoomReq struct {
	Name string `json:"name"`
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	if !s.joinLimit.Allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "slow down")
		return
	}
	var req createRoomReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeErr(w, http.StatusBadRequest, "name must be 1-100 characters")
		return
	}

	room, err := s.store.CreateRoom(r.Context(), req.Name, secrets.RoomSecret())
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"room":     room,
		"join_url": s.cfg.PublicURL + "/r/" + room.Secret,
	})
}

type joinRoomReq struct {
	Secret      string `json:"secret"`
	Name        string `json:"name"`
	Avatar      string `json:"avatar"`
	Description string `json:"description"`
	IsHuman     bool   `json:"is_human"`
}

func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	if !s.joinLimit.Allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "slow down")
		return
	}
	var req joinRoomReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Secret = normalizeSecret(req.Secret)
	if !validName(req.Name) {
		writeErr(w, http.StatusBadRequest, "name must match ^[a-z0-9][a-z0-9_-]{1,31}$")
		return
	}
	if req.Avatar == "" {
		req.Avatar = "🤖"
		if req.IsHuman {
			req.Avatar = "🧑"
		}
	}
	if len(req.Avatar) > 300 || len(req.Description) > 2000 {
		writeErr(w, http.StatusBadRequest, "avatar or description too long")
		return
	}

	room, err := s.store.RoomBySecret(r.Context(), req.Secret)
	if err != nil {
		writeStoreErr(w, err)
		return
	}

	token, hash := secrets.NewToken()
	p, err := s.store.CreateParticipant(r.Context(), room.ID, req.Name, req.Avatar, req.Description, req.IsHuman, hash)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"token":       token,
		"participant": p,
		"room":        room,
	})
}

// handlePeekRoom lets holders of a secret see the room name before joining.
func (s *Server) handlePeekRoom(w http.ResponseWriter, r *http.Request) {
	if !s.joinLimit.Allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "slow down")
		return
	}
	room, err := s.store.RoomBySecret(r.Context(), normalizeSecret(r.URL.Query().Get("secret")))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": room.Name, "created_at": room.CreatedAt})
}

func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request, p models.Participant) {
	room, err := s.store.RoomByID(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	channels, err := s.store.ListChannels(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	participants, err := s.store.ListParticipants(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"room":         room,
		"join_url":     s.cfg.PublicURL + "/r/" + room.Secret,
		"channels":     channels,
		"participants": participants,
	})
}

// normalizeSecret tolerates pasted join URLs and surrounding whitespace.
func normalizeSecret(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "/r/"); i >= 0 {
		s = s[i+3:]
	}
	return strings.Trim(s, "/ ")
}
