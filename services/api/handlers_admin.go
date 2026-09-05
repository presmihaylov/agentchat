package api

import (
	"log"
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
	room, err := s.store.RenameRoom(r.Context(), p.RoomID, req.Name, p.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, room)
}

type deleteRoomReq struct {
	Name string `json:"name"`
}

// Only the owner (the user who created the room) may delete it; the typed
// name is the confirmation. Agents have no user, so they never qualify.
func (s *Server) handleDeleteRoom(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !requireAdmin(w, p) {
		return
	}
	room, err := s.store.RoomByID(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	if p.UserID == nil || room.CreatedByUserID == nil || *p.UserID != *room.CreatedByUserID {
		writeErrCode(w, http.StatusForbidden, "owner_required", "only the workspace owner can delete it")
		return
	}
	var req deleteRoomReq
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) != room.Name {
		writeErrCode(w, http.StatusBadRequest, "name_mismatch", "type the workspace name exactly to confirm")
		return
	}
	if err := s.store.DeleteRoom(r.Context(), room.ID); err != nil {
		writeStoreErr(w, err)
		return
	}
	log.Printf("room %s (%s) deleted by user %s", room.ID, room.Slug, *p.UserID)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "slug": room.Slug})
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
	// the owner stays admin: a demoted owner could neither leave nor delete
	if owner, err := s.isRoomOwner(r, target); err != nil {
		writeStoreErr(w, err)
		return
	} else if owner {
		writeErrCode(w, http.StatusForbidden, "owner_protected", "the workspace owner's role cannot change")
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

// isRoomOwner: the target's account created the room
func (s *Server) isRoomOwner(r *http.Request, target models.Participant) (bool, error) {
	if target.UserID == nil {
		return false, nil
	}
	room, err := s.store.RoomByID(r.Context(), target.RoomID)
	if err != nil {
		return false, err
	}
	return room.CreatedByUserID != nil && *target.UserID == *room.CreatedByUserID, nil
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
	owner, err := s.isRoomOwner(r, target)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	// the owner is the one row nobody removes: not an admin, not the owner themself
	if owner {
		if target.ID == p.ID {
			writeErrCode(w, http.StatusBadRequest, "owner_cannot_leave", "the workspace owner cannot leave it; delete the workspace instead")
			return
		}
		writeErrCode(w, http.StatusForbidden, "owner_protected", "the workspace owner cannot be removed")
		return
	}
	if err := s.store.Revoke(r.Context(), p.RoomID, target.ID, p.ID); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// handleSetRoomAvatar: the workspace image, admins only. Members see it through
// GET /room and the switcher; the initials fallback returns on DELETE.
func (s *Server) handleSetRoomAvatar(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !requireAdmin(w, p) {
		return
	}
	meta, ok := s.readAvatarUpload(w, r, p)
	if !ok {
		return
	}
	room, err := s.store.SetRoomAvatar(r.Context(), p.RoomID, &meta.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, room)
}

func (s *Server) handleRemoveRoomAvatar(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !requireAdmin(w, p) {
		return
	}
	room, err := s.store.SetRoomAvatar(r.Context(), p.RoomID, nil)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, room)
}
