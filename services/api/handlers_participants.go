package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/presmihaylov/agentchat/models"
)

func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request, p models.Participant) {
	me, err := s.store.ParticipantByID(r.Context(), p.RoomID, p.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, me)
}

type updateMeReq struct {
	Name        *string `json:"name"`
	Avatar      *string `json:"avatar"`
	Description *string `json:"description"`
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request, p models.Participant) {
	var req updateMeReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Name != nil && !validName(*req.Name) {
		writeErr(w, http.StatusBadRequest, "name must match ^[a-z0-9][a-z0-9_-]{1,31}$")
		return
	}
	if req.Name != nil && reservedNames[*req.Name] {
		writeErr(w, http.StatusBadRequest, "that name is reserved")
		return
	}
	if req.Avatar != nil && len(*req.Avatar) > 300 {
		writeErr(w, http.StatusBadRequest, "avatar too long")
		return
	}
	if req.Description != nil && len(*req.Description) > 2000 {
		writeErr(w, http.StatusBadRequest, "description too long")
		return
	}
	me, err := s.store.UpdateProfile(r.Context(), p.RoomID, p.ID, req.Name, req.Avatar, req.Description)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func (s *Server) handleGoOffline(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if err := s.store.GoOffline(r.Context(), p.RoomID, p.ID); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "offline"})
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request, p models.Participant) {
	// authed() already touched presence
	writeJSON(w, http.StatusOK, map[string]string{"status": "online"})
}

func (s *Server) handleListParticipants(w http.ResponseWriter, r *http.Request, p models.Participant) {
	list, err := s.store.ListParticipants(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"participants": list})
}

// resolveParticipant accepts a participant id, a name, or "me".
func (s *Server) resolveParticipant(r *http.Request, me models.Participant, ref string) (models.Participant, error) {
	if ref == "me" || ref == me.ID {
		return s.store.ParticipantByID(r.Context(), me.RoomID, me.ID)
	}
	p, err := s.store.ParticipantByName(r.Context(), me.RoomID, ref)
	if err == nil {
		return p, nil
	}
	// only a clean miss falls through to id lookup; other errors must surface
	if !errors.Is(err, models.ErrNotFound) {
		return models.Participant{}, err
	}
	if !isUUID(ref) {
		return models.Participant{}, models.ErrNotFound
	}
	return s.store.ParticipantByID(r.Context(), me.RoomID, ref)
}

func (s *Server) handleGetParticipant(w http.ResponseWriter, r *http.Request, p models.Participant) {
	got, err := s.resolveParticipant(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

type addTagReq struct {
	Tag string `json:"tag"`
}

func (s *Server) handleAddTag(w http.ResponseWriter, r *http.Request, p models.Participant) {
	target, err := s.resolveParticipant(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	var req addTagReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Tag = strings.ToLower(strings.TrimSpace(req.Tag))
	if req.Tag == "" || len(req.Tag) > 50 {
		writeErr(w, http.StatusBadRequest, "tag must be 1-50 characters")
		return
	}
	if err := s.store.AddTag(r.Context(), p.RoomID, target.ID, req.Tag, p.ID); err != nil {
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

func (s *Server) handleRemoveTag(w http.ResponseWriter, r *http.Request, p models.Participant) {
	target, err := s.resolveParticipant(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	tag := strings.ToLower(strings.TrimSpace(r.PathValue("tag")))
	if err := s.store.RemoveTag(r.Context(), p.RoomID, target.ID, tag); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}
