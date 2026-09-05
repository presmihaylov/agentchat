package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/pkg/secrets"
)

type createRoomReq struct {
	Name string `json:"name"`
}

// handleCreateRoom: only a logged-in human creates a workspace; the creator
// lands in it as admin. The per-creator quota replaces the per-IP limit.
func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request, u models.User) {
	var req createRoomReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeErr(w, http.StatusBadRequest, "name must be 1-100 characters")
		return
	}

	room, _, err := s.store.CreateRoomAs(r.Context(), req.Name, secrets.RoomSlug(), secrets.InviteCode(), u)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"room":        room,
		"join_url":    s.cfg.PublicURL + "/r/" + room.Slug,
		"invite_code": room.Secret,
	})
}

type enterWorkspaceReq struct {
	InviteCode string `json:"invite_code"`
}

// handleEnterWorkspace makes a logged-in user a member of the room behind
// {slug}. A live member is idempotent, a revoked one stays out, and a
// newcomer needs a code that opens this very room. Never adopts a row by name.
func (s *Server) handleEnterWorkspace(w http.ResponseWriter, r *http.Request, u models.User) {
	var req enterWorkspaceReq
	if !readJSON(w, r, &req) {
		return
	}
	room, err := s.store.RoomBySlug(r.Context(), r.PathValue("slug"))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	room.Secret = ""

	p, err := s.store.ParticipantForUser(r.Context(), room.ID, u.ID)
	if err == nil && p.Revoked {
		writeWorkspaceForbidden(w, "revoked")
		return
	}
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"participant": p, "room": room})
		return
	}
	if !errors.Is(err, models.ErrNotFound) {
		writeStoreErr(w, err)
		return
	}

	target, _, err := s.store.RoomByAnySecret(r.Context(), normalizeCode(req.InviteCode))
	if errors.Is(err, models.ErrNotFound) || (err == nil && target.ID != room.ID) {
		writeStoreErr(w, models.ErrInviteInvalid)
		return
	}
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	p, err = s.store.EnterRoom(r.Context(), room.ID, u)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"participant": p, "room": room})
}

func writeWorkspaceForbidden(w http.ResponseWriter, reason string) {
	msg := "you are not a member of this workspace"
	if reason == "revoked" {
		msg = "you were removed from this workspace"
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": msg, "code": "workspace_forbidden", "reason": reason})
}

type joinRoomReq struct {
	InviteCode  string `json:"invite_code"`
	Secret      string `json:"secret"` // legacy alias for invite_code
	Name        string `json:"name"`
	Avatar      string `json:"avatar"`
	Description string `json:"description"`
	IsHuman     bool   `json:"is_human"`
}

func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	if !s.joinLimit.Allow(s.clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "slow down")
		return
	}
	var req joinRoomReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.InviteCode == "" {
		req.InviteCode = req.Secret
	}
	req.InviteCode = normalizeCode(req.InviteCode)
	if !validParticipantName(req.Name) {
		writeErr(w, http.StatusBadRequest, "name must be 2-32 chars: letters, digits, spaces, - or _; no leading/trailing/double spaces")
		return
	}
	if isReservedName(req.Name) {
		writeErr(w, http.StatusBadRequest, "that name is reserved")
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

	room, ownerID, err := s.store.RoomByAnySecret(r.Context(), req.InviteCode)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	room.Secret = ""
	if req.IsHuman {
		// humans are their own principal; only agents get bound to an owner
		ownerID = nil
	}

	token, hash := secrets.NewToken()
	p, err := s.store.CreateParticipant(r.Context(), room.ID, req.Name, req.Avatar, req.Description, req.IsHuman, hash, ownerID, nil)
	if errors.Is(err, models.ErrConflict) {
		// same name = same identity: re-claim it with a fresh token so a
		// restarted agent does not pile up orphan duplicates
		p, err = s.store.ReclaimParticipant(r.Context(), room.ID, req.Name, hash, ownerID)
		if errors.Is(err, models.ErrIdentityOnline) {
			writeErr(w, http.StatusConflict,
				"that name is taken by a participant that is online right now; wait for it to go offline (~90s idle) or pick another name")
			return
		}
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"token":       token,
			"participant": p,
			"room":        room,
			"reclaimed":   true,
		})
		return
	}
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

// handleCreateInvite mints an owner-scoped invite code: agents joining with it
// are bound to the issuer's principal, so ownership is server-verified.
func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request, p models.Participant) {
	code := secrets.InviteCode()
	if err := s.store.CreateInvite(r.Context(), p.RoomID, p.ID, code); err != nil {
		writeStoreErr(w, err)
		return
	}
	room, err := s.store.RoomByID(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	out := map[string]any{
		"invite_code": code,
		"join_url":    s.cfg.PublicURL + "/r/" + room.Slug,
	}
	// behind Cloudflare Access a bare curl to /skill gets the login page, so the
	// invite text has to carry the service token; the caller is already a member
	if s.cfg.AccessClientID != "" {
		out["access"] = map[string]string{
			"client_id":     s.cfg.AccessClientID,
			"client_secret": s.cfg.AccessClientSecret,
		}
	}
	writeJSON(w, http.StatusCreated, out)
}

// handlePeekRoom shows the room name behind a join URL. The slug is not a
// secret; the name is the only thing it reveals.
func (s *Server) handlePeekRoom(w http.ResponseWriter, r *http.Request) {
	if !s.joinLimit.Allow(s.clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "slow down")
		return
	}
	room, err := s.store.RoomBySlug(r.Context(), strings.TrimSpace(r.URL.Query().Get("slug")))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	// the image needs membership to fetch, so the peek carries only the initials colour
	writeJSON(w, http.StatusOK, map[string]any{"name": room.Name, "created_at": room.CreatedAt, "color": room.Color})
}

func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request, p models.Participant) {
	room, err := s.store.RoomByID(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	channels, err := s.store.ListChannelsUnread(r.Context(), p.RoomID, p.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	participants, err := s.store.ListParticipants(r.Context(), p.RoomID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	// The join URL (slug) is not a secret. The invite code is: only admins
	// see it, otherwise any member could re-learn it after a rotation,
	// making eviction (rotate then kick) impossible to ever make stick.
	inviteCode := ""
	if isAdmin(p) {
		inviteCode = room.Secret
	}
	room.Secret = inviteCode
	writeJSON(w, http.StatusOK, map[string]any{
		"room":         room,
		"join_url":     s.cfg.PublicURL + "/r/" + room.Slug,
		"invite_code":  inviteCode,
		"channels":     channels,
		"participants": participants,
	})
}

// normalizeCode tolerates surrounding whitespace and slashes in a pasted code.
func normalizeCode(s string) string {
	return strings.Trim(strings.TrimSpace(s), "/ ")
}
