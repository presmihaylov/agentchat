package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/pkg/mentions"
)

const (
	maxMessageBytes    = 32 * 1024
	maxAttachmentBytes = 5 * 1024 * 1024
)

type postMessageReq struct {
	Body          string   `json:"body"`
	ThreadRootID  *string  `json:"thread_root_id"`
	AttachmentIDs []string `json:"attachment_ids"`
	Broadcast     bool     `json:"broadcast"`
}

func (s *Server) handlePostMessage(w http.ResponseWriter, r *http.Request, p models.Participant) {
	ch, err := s.resolveChannel(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	if ch.Archived {
		writeErr(w, http.StatusConflict, "channel is archived")
		return
	}

	var req postMessageReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" && len(req.AttachmentIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "message needs a body or attachments")
		return
	}
	if len(req.Body) > maxMessageBytes {
		writeErr(w, http.StatusBadRequest, "message too long (32KB max)")
		return
	}
	if len(req.AttachmentIDs) > 10 {
		writeErr(w, http.StatusBadRequest, "too many attachments (10 max)")
		return
	}
	seenAtt := map[string]bool{}
	dedupedAtt := make([]string, 0, len(req.AttachmentIDs))
	for _, aid := range req.AttachmentIDs {
		if !isUUID(aid) {
			writeErr(w, http.StatusBadRequest, "invalid attachment id: "+aid)
			return
		}
		if seenAtt[aid] {
			continue
		}
		seenAtt[aid] = true
		dedupedAtt = append(dedupedAtt, aid)
	}
	req.AttachmentIDs = dedupedAtt

	// replies always attach to the thread root, never nest
	if req.ThreadRootID != nil {
		if !isUUID(*req.ThreadRootID) {
			writeErr(w, http.StatusNotFound, "thread root not found")
			return
		}
		root, err := s.store.MessageByID(r.Context(), p.RoomID, *req.ThreadRootID)
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		if root.ChannelID != ch.ID {
			writeErr(w, http.StatusBadRequest, "thread root is in a different channel")
			return
		}
		if root.ThreadRootID != nil {
			req.ThreadRootID = root.ThreadRootID
		}
	}

	participants, err := s.store.ListParticipants(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	known := map[string]bool{}
	byName := map[string]string{}
	for _, part := range participants {
		known[part.Name] = true
		byName[part.Name] = part.ID
	}
	names, broadcast := mentions.Parse(req.Body, known)
	mentionIDs := make([]string, 0, len(names))
	for _, n := range names {
		mentionIDs = append(mentionIDs, byName[n])
	}

	msg, err := s.store.CreateMessage(r.Context(), models.CreateMessageParams{
		RoomID:        p.RoomID,
		ChannelID:     ch.ID,
		ThreadRootID:  req.ThreadRootID,
		AuthorID:      p.ID,
		Body:          req.Body,
		IsBroadcast:   req.Broadcast || broadcast,
		AttachmentIDs: req.AttachmentIDs,
		MentionIDs:    mentionIDs,
	})
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, msg)
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request, p models.Participant) {
	ch, err := s.resolveChannel(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	var before *time.Time
	if b := q.Get("before"); b != "" {
		t, err := time.Parse(time.RFC3339, b)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "before must be RFC3339")
			return
		}
		before = &t
	}
	var beforeID *string
	var beforeAt *time.Time
	if bid := q.Get("before_id"); bid != "" {
		if !isUUID(bid) {
			writeErr(w, http.StatusNotFound, "before_id not found")
			return
		}
		cursor, err := s.store.MessageByID(r.Context(), p.RoomID, bid)
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		beforeID = &cursor.ID
		beforeAt = &cursor.CreatedAt
	}
	msgs, err := s.store.ListChannelMessages(r.Context(), p.RoomID, ch.ID, before, beforeID, beforeAt, limit)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": ch, "messages": msgs})
}

func (s *Server) handleGetMessage(w http.ResponseWriter, r *http.Request, p models.Participant) {
	id := r.PathValue("id")
	if !isUUID(id) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	msg, err := s.store.MessageByID(r.Context(), p.RoomID, id)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msg)
}

type editMessageReq struct {
	Body string `json:"body"`
}

// handleEditMessage: authors edit their own messages (mentions are not re-parsed).
func (s *Server) handleEditMessage(w http.ResponseWriter, r *http.Request, p models.Participant) {
	id := r.PathValue("id")
	if !isUUID(id) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	msg, err := s.store.MessageByID(r.Context(), p.RoomID, id)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	if msg.AuthorID != p.ID {
		writeErr(w, http.StatusForbidden, "only the author can edit a message")
		return
	}
	var req editMessageReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" || len(req.Body) > maxMessageBytes {
		writeErr(w, http.StatusBadRequest, "body must be 1 byte to 32KB")
		return
	}
	updated, err := s.store.UpdateMessageBody(r.Context(), p.RoomID, id, req.Body)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleDeleteMessage: the author or an admin; deleting a thread root deletes its replies.
func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request, p models.Participant) {
	id := r.PathValue("id")
	if !isUUID(id) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	msg, err := s.store.MessageByID(r.Context(), p.RoomID, id)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	if msg.AuthorID != p.ID && !isAdmin(p) {
		writeErr(w, http.StatusForbidden, "only the author or an admin can delete a message")
		return
	}
	if err := s.store.DeleteMessage(r.Context(), p.RoomID, id); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) handleGetThread(w http.ResponseWriter, r *http.Request, p models.Participant) {
	id := r.PathValue("id")
	if !isUUID(id) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	msgs, err := s.store.ListThread(r.Context(), p.RoomID, id, limit)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

// resolveThreadRoot maps a message id (root or reply) to the thread's root.
func (s *Server) resolveThreadRoot(r *http.Request, p models.Participant) (string, error) {
	id := r.PathValue("id")
	if !isUUID(id) {
		return "", models.ErrNotFound
	}
	m, err := s.store.MessageByID(r.Context(), p.RoomID, id)
	if err != nil {
		return "", err
	}
	if m.ThreadRootID != nil {
		return *m.ThreadRootID, nil
	}
	return m.ID, nil
}

// handleListThreads: the caller's thread tree for one channel — threads they
// started, replied in, or were mentioned in.
func (s *Server) handleListThreads(w http.ResponseWriter, r *http.Request, p models.Participant) {
	ch, err := s.resolveChannel(r, p, r.PathValue("id"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	list, err := s.store.ListInvolvedThreads(r.Context(), p.RoomID, ch.ID, p.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": list})
}

func (s *Server) handleThreadRead(w http.ResponseWriter, r *http.Request, p models.Participant) {
	root, err := s.resolveThreadRoot(r, p)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	at, err := s.store.MarkThreadRead(r.Context(), p.ID, root)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"root_id": root, "last_read_at": at})
}

type threadMuteReq struct {
	Muted bool `json:"muted"`
}

func (s *Server) handleThreadMute(w http.ResponseWriter, r *http.Request, p models.Participant) {
	root, err := s.resolveThreadRoot(r, p)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	var req threadMuteReq
	if !readJSON(w, r, &req) {
		return
	}
	if err := s.store.SetThreadMuted(r.Context(), p.ID, root, req.Muted); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"root_id": root, "muted": req.Muted})
}

func (s *Server) handleUploadAttachment(w http.ResponseWriter, r *http.Request, p models.Participant) {
	if !s.uploadLimit.Allow("up:" + p.ID) {
		writeErr(w, http.StatusTooManyRequests, "too many uploads, slow down")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes+64*1024)
	if err := r.ParseMultipartForm(maxAttachmentBytes); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "attachment exceeds 5MB")
			return
		}
		writeErr(w, http.StatusBadRequest, "invalid multipart form (5MB max): "+err.Error())
		return
	}
	// ParseMultipartForm spills parts over the memory limit to temp files on
	// disk; without this they leak until process exit
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, `multipart field "file" is required`)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxAttachmentBytes+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "failed reading upload")
		return
	}
	if len(data) > maxAttachmentBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "attachment exceeds 5MB")
		return
	}

	filename := header.Filename
	if filename == "" {
		filename = "attachment"
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	meta, err := s.store.CreateAttachment(r.Context(), p.RoomID, p.ID, filename, contentType, data)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, meta)
}

func (s *Server) handleGetAttachment(w http.ResponseWriter, r *http.Request, p models.Participant) {
	id := r.PathValue("id")
	if !isUUID(id) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	a, err := s.store.AttachmentByID(r.Context(), p.RoomID, id)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	// never let uploaded content execute in the UI's origin
	w.Header().Set("Content-Type", safeContentType(a.ContentType))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(a.Filename)+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(a.Data)
}

// safeContentType downgrades types browsers would execute or render as HTML.
func safeContentType(ct string) string {
	lower := strings.ToLower(ct)
	for _, bad := range []string{"text/html", "application/xhtml", "image/svg"} {
		if strings.HasPrefix(lower, bad) {
			return "application/octet-stream"
		}
	}
	return ct
}

func sanitizeFilename(name string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r < 32 {
			return '_'
		}
		return r
	}, name)
}
