package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/presmihaylov/agentchat/models"
)

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request, p models.Participant) {
	list, err := s.store.ListChannelsUnread(r.Context(), p.RoomID, p.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": list})
}

// handleMarkRead advances the caller's read marker for a channel to now.
func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request, p models.Participant) {
	ch, err := s.resolveChannel(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	at, err := s.store.MarkChannelRead(r.Context(), p.ID, ch.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel_id": ch.ID, "last_read_at": at})
}

type createChannelReq struct {
	Name  string `json:"name"`
	Topic string `json:"topic"`
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request, p models.Participant) {
	var req createChannelReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(req.Name, "#")))
	if !validName(req.Name) {
		writeErr(w, http.StatusBadRequest, "channel name must match ^[a-z0-9][a-z0-9_-]{1,31}$")
		return
	}
	if len(req.Topic) > 500 {
		writeErr(w, http.StatusBadRequest, "topic too long")
		return
	}
	ch, err := s.store.CreateChannel(r.Context(), p.RoomID, req.Name, req.Topic, p.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, ch)
}

type updateChannelReq struct {
	Archived *bool `json:"archived"`
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request, p models.Participant) {
	ch, err := s.resolveChannel(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	var req updateChannelReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Archived == nil {
		writeErr(w, http.StatusBadRequest, "nothing to update")
		return
	}
	// Slack-style: general can never be archived; only admins or the creator manage archive state
	if ch.Name == "general" {
		writeErr(w, http.StatusConflict, "the general channel cannot be archived")
		return
	}
	isCreator := ch.CreatedBy != nil && *ch.CreatedBy == p.ID
	if !isAdmin(p) && !isCreator {
		writeErr(w, http.StatusForbidden, "only admins or the channel creator can (un)archive it")
		return
	}
	if err := s.store.SetChannelArchived(r.Context(), p.RoomID, ch.ID, *req.Archived); err != nil {
		writeStoreErr(w, err)
		return
	}
	ch, err = s.store.ChannelByID(r.Context(), p.RoomID, ch.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ch)
}

// handleDeleteChannel: admin only; deleting a channel deletes its messages.
func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !requireAdmin(w, p) {
		return
	}
	ch, err := s.resolveChannel(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	if ch.Name == "general" {
		writeErr(w, http.StatusConflict, "the general channel cannot be deleted")
		return
	}
	if err := s.store.DeleteChannel(r.Context(), p.RoomID, ch.ID); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// resolveChannel accepts a channel id or a name (with or without '#').
func (s *Server) resolveChannel(r *http.Request, p models.Participant, ref string) (models.Channel, error) {
	ref = strings.TrimPrefix(ref, "#")
	ch, err := s.store.ChannelByName(r.Context(), p.RoomID, ref)
	if err == nil {
		return ch, nil
	}
	// only a clean miss falls through to id lookup; other errors must surface
	if !errors.Is(err, models.ErrNotFound) {
		return models.Channel{}, err
	}
	if !isUUID(ref) {
		return models.Channel{}, models.ErrNotFound
	}
	return s.store.ChannelByID(r.Context(), p.RoomID, ref)
}
