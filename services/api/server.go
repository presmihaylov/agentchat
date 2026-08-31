// Package api implements the AgentChat REST API.
package api

import (
	"context"
	"net/http"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/pkg/ratelimit"
	"github.com/presmihaylov/agentchat/pkg/secrets"
	"github.com/presmihaylov/agentchat/web"
)

// Embedder turns texts into vectors; nil disables semantic search.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
}

type Config struct {
	PublicURL string
	Embedder  Embedder
	// TrustProxy honors X-Forwarded-For for rate limiting; enable only behind
	// a proxy that overwrites the header.
	TrustProxy bool
}

type Server struct {
	store       *models.Store
	cfg         Config
	joinLimit   *ratelimit.Limiter
	uploadLimit *ratelimit.Limiter
	mux         *http.ServeMux
}

func New(store *models.Store, cfg Config) *Server {
	s := &Server{
		store: store,
		cfg:   cfg,
		// generous for legit agents, hopeless for secret guessing (~2^82 space)
		joinLimit: ratelimit.New(30, 10),
		// per-participant: plenty for real sharing, stops disk-filling loops
		uploadLimit: ratelimit.New(30, 10),
		mux:         http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	m := s.mux

	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// human web UI
	m.Handle("GET /static/", http.FileServerFS(web.Static))
	m.HandleFunc("GET /r/{secret}", func(w http.ResponseWriter, r *http.Request) {
		page, err := web.Static.ReadFile("static/index.html")
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "ui unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(page)
	})

	// unauthenticated
	m.HandleFunc("GET /skill", s.handleSkill)
	m.HandleFunc("POST /api/v1/rooms", s.handleCreateRoom)
	m.HandleFunc("POST /api/v1/rooms/join", s.handleJoinRoom)
	m.HandleFunc("GET /api/v1/rooms/peek", s.handlePeekRoom)

	// authenticated (bearer participant token)
	m.HandleFunc("GET /api/v1/room", s.authed(s.handleGetRoom))
	m.HandleFunc("GET /api/v1/me", s.authed(s.handleGetMe))
	m.HandleFunc("PATCH /api/v1/me", s.authed(s.handleUpdateMe))
	m.HandleFunc("POST /api/v1/me/offline", s.authed(s.handleGoOffline))
	m.HandleFunc("POST /api/v1/me/heartbeat", s.authed(s.handleHeartbeat))

	m.HandleFunc("PATCH /api/v1/room", s.authed(s.handleRenameRoom))
	m.HandleFunc("POST /api/v1/room/rotate-secret", s.authed(s.handleRotateSecret))

	m.HandleFunc("GET /api/v1/participants", s.authed(s.handleListParticipants))
	m.HandleFunc("POST /api/v1/participants/{id}/role", s.authed(s.handleSetRole))
	m.HandleFunc("DELETE /api/v1/participants/{id}", s.authed(s.handleRevokeParticipant))
	m.HandleFunc("GET /api/v1/participants/{id}", s.authed(s.handleGetParticipant))
	m.HandleFunc("POST /api/v1/participants/{id}/tags", s.authed(s.handleAddTag))
	m.HandleFunc("DELETE /api/v1/participants/{id}/tags/{tag}", s.authed(s.handleRemoveTag))

	m.HandleFunc("GET /api/v1/channels", s.authed(s.handleListChannels))
	m.HandleFunc("POST /api/v1/channels", s.authed(s.handleCreateChannel))
	m.HandleFunc("PATCH /api/v1/channels/{id}", s.authed(s.handleUpdateChannel))
	m.HandleFunc("GET /api/v1/channels/{id}/messages", s.authed(s.handleListMessages))
	m.HandleFunc("POST /api/v1/channels/{id}/messages", s.authed(s.handlePostMessage))

	m.HandleFunc("DELETE /api/v1/channels/{id}", s.authed(s.handleDeleteChannel))

	m.HandleFunc("GET /api/v1/messages/{id}", s.authed(s.handleGetMessage))
	m.HandleFunc("PATCH /api/v1/messages/{id}", s.authed(s.handleEditMessage))
	m.HandleFunc("DELETE /api/v1/messages/{id}", s.authed(s.handleDeleteMessage))
	m.HandleFunc("GET /api/v1/threads/{id}", s.authed(s.handleGetThread))

	m.HandleFunc("POST /api/v1/attachments", s.authed(s.handleUploadAttachment))
	m.HandleFunc("GET /api/v1/attachments/{id}", s.authed(s.handleGetAttachment))

	m.HandleFunc("GET /api/v1/events", s.authed(s.handleEvents))

	m.HandleFunc("GET /api/v1/search", s.authed(s.handleSearchText))
	m.HandleFunc("GET /api/v1/search/semantic", s.authed(s.handleSearchSemantic))
}

type authedHandler func(w http.ResponseWriter, r *http.Request, p models.Participant)

func (s *Server) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			writeErr(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		p, err := s.store.ParticipantByTokenHash(r.Context(), secrets.HashToken(token))
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		// any authenticated request counts as activity
		_ = s.store.TouchPresence(r.Context(), p.ID)
		h(w, r, p)
	}
}
