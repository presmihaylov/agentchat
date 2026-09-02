package api

import (
	"errors"
	"io"
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
	if req.Name != nil && !validParticipantName(*req.Name) {
		writeErr(w, http.StatusBadRequest, "name must be 2-32 chars: letters, digits, spaces, - or _; no leading/trailing/double spaces")
		return
	}
	if req.Name != nil && isReservedName(*req.Name) {
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

// handleSetAvatar uploads a profile image (stored like any attachment) and
// points the caller's avatar at it. The emoji avatar stays as the fallback.
func (s *Server) handleSetAvatar(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !s.uploadLimit.Allow("up:" + p.ID) {
		writeErr(w, http.StatusTooManyRequests, "too many uploads, slow down")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes+64*1024)
	if err := r.ParseMultipartForm(maxAttachmentBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid multipart form (5MB max): "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, `multipart field "file" is required`)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxAttachmentBytes+1))
	if err != nil || len(data) > maxAttachmentBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "avatar image exceeds 5MB")
		return
	}
	// sniff, don't trust the client header — avatars render as <img> for everyone
	contentType := http.DetectContentType(data)
	if !strings.HasPrefix(contentType, "image/") {
		writeErr(w, http.StatusBadRequest, "avatar must be an image (png, jpeg, gif, webp)")
		return
	}
	filename := header.Filename
	if filename == "" {
		filename = "avatar"
	}
	meta, err := s.store.CreateAttachment(r.Context(), p.RoomID, p.ID, filename, contentType, data)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	me, err := s.store.SetAvatarAttachment(r.Context(), p.RoomID, p.ID, &meta.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func (s *Server) handleRemoveAvatar(w http.ResponseWriter, r *http.Request, p models.Participant) {
	me, err := s.store.SetAvatarAttachment(r.Context(), p.RoomID, p.ID, nil)
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

func (s *Server) handleGetNotifyPrefs(w http.ResponseWriter, r *http.Request, p models.Participant) {
	np, err := s.store.NotifyPrefs(r.Context(), p.RoomID, p.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, np)
}

type notifyPrefsReq struct {
	Enabled          *bool `json:"enabled"`
	Sound            *bool `json:"sound"`
	ArchiveAfterSecs *int  `json:"archive_after_secs"`
}

func (s *Server) handleSetNotifyPrefs(w http.ResponseWriter, r *http.Request, p models.Participant) {
	var req notifyPrefsReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Enabled == nil && req.Sound == nil && req.ArchiveAfterSecs == nil {
		writeErr(w, http.StatusBadRequest, "nothing to change: send enabled, sound and/or archive_after_secs")
		return
	}
	if req.ArchiveAfterSecs != nil && *req.ArchiveAfterSecs < 0 {
		writeErr(w, http.StatusBadRequest, "archive_after_secs must be 0 (never) or a positive number of seconds")
		return
	}
	np, err := s.store.SetNotifyPrefs(r.Context(), p.RoomID, p.ID, req.Enabled, req.Sound, req.ArchiveAfterSecs)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, np)
}
