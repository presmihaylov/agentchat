package api

import (
	"net/http"
	"strings"

	"github.com/presmihaylov/agentchat/models"
)

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request, p models.Participant) {
	list, err := s.store.ListChannels(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": list})
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

// resolveChannel accepts a channel id or a name (with or without '#').
func (s *Server) resolveChannel(r *http.Request, p models.Participant, ref string) (models.Channel, error) {
	ref = strings.TrimPrefix(ref, "#")
	if ch, err := s.store.ChannelByName(r.Context(), p.RoomID, ref); err == nil {
		return ch, nil
	}
	if !isUUID(ref) {
		return models.Channel{}, models.ErrNotFound
	}
	return s.store.ChannelByID(r.Context(), p.RoomID, ref)
}
