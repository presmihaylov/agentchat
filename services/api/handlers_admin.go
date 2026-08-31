package api

import (
	"net/http"
	"strings"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/pkg/secrets"
)

func isAdmin(p models.Participant) bool { return p.Role == "admin" }

func requireAdmin(w http.ResponseWriter, p models.Participant) bool {
	if !isAdmin(p) {
		writeErr(w, http.StatusForbidden, "admin role required")
		return false
	}
	return true
}

type renameRoomReq struct {
	Name string `json:"name"`
}

func (s *Server) handleRenameRoom(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !requireAdmin(w, p) {
		return
	}
	var req renameRoomReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeErr(w, http.StatusBadRequest, "name must be 1-100 characters")
		return
	}
	room, err := s.store.RenameRoom(r.Context(), p.RoomID, req.Name)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, room)
}

func (s *Server) handleRotateSecret(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !requireAdmin(w, p) {
		return
	}
	room, err := s.store.RotateSecret(r.Context(), p.RoomID, secrets.InviteCode())
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"room":        room,
		"join_url":    s.cfg.PublicURL + "/r/" + room.Slug,
		"invite_code": room.Secret,
	})
}

type setRoleReq struct {
	Role string `json:"role"`
}

func (s *Server) handleSetRole(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !requireAdmin(w, p) {
		return
	}
	target, err := s.resolveParticipant(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	var req setRoleReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Role != "admin" && req.Role != "member" {
		writeErr(w, http.StatusBadRequest, `role must be "admin" or "member"`)
		return
	}
	if err := s.store.SetRole(r.Context(), p.RoomID, target.ID, req.Role); err != nil {
		writeStoreErr(w, err)
		return
	}
	got, err := s.store.ParticipantByID(r.Context(), p.RoomID, target.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

// handleRevokeParticipant: admins kick anyone (Slack-style deactivation);
// non-admins may only remove themselves (leave).
func (s *Server) handleRevokeParticipant(w http.ResponseWriter, r *http.Request, p models.Participant) {
	target, err := s.resolveParticipant(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	if !isAdmin(p) && target.ID != p.ID {
		writeErr(w, http.StatusForbidden, "only admins can remove other participants")
		return
	}
	if err := s.store.Revoke(r.Context(), p.RoomID, target.ID); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}
