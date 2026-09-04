// Package api implements the AgentChat REST API.
package api

import (
	"context"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/pkg/ratelimit"
	"github.com/presmihaylov/agentchat/pkg/secrets"
	"github.com/presmihaylov/agentchat/services/auth"
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
	// AccessClientID / AccessClientSecret are a Cloudflare Access service
	// token. When set, the served cli.sh carries them so agents get through
	// Access without a browser login. See docs/CLOUDFLARE.md.
	AccessClientID     string
	AccessClientSecret string
	// Providers verifies human logins; required. SessionTTL is the sliding
	// idle window of a ses_ session (default 720h, capped at models.SessionMaxAge).
	Providers           *auth.Registry
	SessionTTL          time.Duration
	RegistrationEnabled bool
}

const defaultSessionTTL = 720 * time.Hour

type Server struct {
	store       *models.Store
	cfg         Config
	joinLimit   *ratelimit.Limiter
	uploadLimit *ratelimit.Limiter
	mux         *http.ServeMux
}

func New(store *models.Store, cfg Config) *Server {
	if cfg.Providers == nil {
		panic("api.New: Config.Providers is required")
	}
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = defaultSessionTTL
	}
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

	// human web UI (Vite build output)
	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		panic(err) // embed layout is fixed at compile time
	}
	m.Handle("GET /assets/", http.FileServerFS(dist))
	m.Handle("GET /vendor/", http.FileServerFS(dist))
	serveApp := func(w http.ResponseWriter, r *http.Request) {
		page, err := web.Dist.ReadFile("dist/index.html")
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "ui unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(page)
	}
	m.HandleFunc("GET /r/{slug}", serveApp)
	// deep links: channel and thread live in the path, the SPA restores them
	m.HandleFunc("GET /r/{slug}/c/{channel}", serveApp)
	m.HandleFunc("GET /r/{slug}/c/{channel}/t/{thread}", serveApp)
	m.HandleFunc("GET /r/{slug}/c/{channel}/m/{message}", serveApp)
	m.HandleFunc("GET /r/{slug}/c/{channel}/t/{thread}/m/{message}", serveApp)
	m.HandleFunc("GET /create", serveApp)
	m.HandleFunc("GET /login", serveApp)
	m.HandleFunc("GET /register", serveApp)
	m.HandleFunc("GET /settings", serveApp)
	m.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/login", http.StatusFound)
	})

	// unauthenticated
	m.HandleFunc("GET /skill", s.handleSkill)
	m.HandleFunc("GET /skill/claude-code", s.handleSkillClaudeCode)
	m.HandleFunc("GET /skill/hermes", s.handleSkillHermes)
	m.HandleFunc("GET /skill/watch.sh", s.handleSkillWatchScript)
	m.HandleFunc("GET /skill/bridge.sh", serveScript(bridgeScript))
	m.HandleFunc("GET /skill/inject.sh", serveScript(injectScript))
	for _, g := range harnessGuides {
		m.HandleFunc("GET /skill/"+g.slug, s.handleSkillHarness(g))
	}
	m.HandleFunc("GET /cli.sh", s.handleCLI)
	m.HandleFunc("POST /api/v1/rooms", s.handleCreateRoom)
	m.HandleFunc("POST /api/v1/rooms/join", s.handleJoinRoom)
	m.HandleFunc("GET /api/v1/rooms/peek", s.handlePeekRoom)

	// human accounts (bearer session token)
	m.HandleFunc("GET /api/v1/auth/providers", s.handleAuthProviders)
	m.HandleFunc("POST /api/v1/auth/password/register", s.handleRegister)
	m.HandleFunc("POST /api/v1/auth/{provider}/login", s.handleLogin)
	m.HandleFunc("POST /api/v1/auth/logout", s.withSession(s.handleLogout))
	m.HandleFunc("POST /api/v1/auth/password/change", s.withSession(s.handleChangePassword))
	m.HandleFunc("GET /api/v1/user", s.withSession(s.handleGetUser))

	// authenticated (bearer participant token)
	m.HandleFunc("GET /api/v1/room", s.authed(s.handleGetRoom))
	m.HandleFunc("POST /api/v1/invites", s.authed(s.handleCreateInvite))
	m.HandleFunc("GET /api/v1/me", s.authed(s.handleGetMe))
	m.HandleFunc("PATCH /api/v1/me", s.authed(s.handleUpdateMe))
	m.HandleFunc("POST /api/v1/me/offline", s.authed(s.handleGoOffline))
	m.HandleFunc("POST /api/v1/me/heartbeat", s.authed(s.handleHeartbeat))
	m.HandleFunc("POST /api/v1/me/avatar", s.authed(s.handleSetAvatar))
	m.HandleFunc("DELETE /api/v1/me/avatar", s.authed(s.handleRemoveAvatar))
	m.HandleFunc("GET /api/v1/me/notifications", s.authed(s.handleGetNotifyPrefs))
	m.HandleFunc("PATCH /api/v1/me/notifications", s.authed(s.handleSetNotifyPrefs))

	m.HandleFunc("PATCH /api/v1/room", s.authed(s.handleRenameRoom))
	m.HandleFunc("POST /api/v1/room/rotate-secret", s.authed(s.handleRotateSecret))

	// the authoritative handle roster clients validate mentions against
	m.HandleFunc("GET /api/v1/members", s.authed(s.handleListMembers))
	m.HandleFunc("GET /api/v1/participants", s.authed(s.handleListParticipants))
	m.HandleFunc("POST /api/v1/participants/{id}/role", s.authed(s.handleSetRole))
	m.HandleFunc("DELETE /api/v1/participants/{id}", s.authed(s.handleRevokeParticipant))
	m.HandleFunc("GET /api/v1/participants/{id}", s.authed(s.handleGetParticipant))
	m.HandleFunc("POST /api/v1/participants/{id}/tags", s.authed(s.handleAddTag))
	m.HandleFunc("DELETE /api/v1/participants/{id}/tags/{tag}", s.authed(s.handleRemoveTag))

	m.HandleFunc("GET /api/v1/channels", s.authed(s.handleListChannels))
	m.HandleFunc("GET /api/v1/channels/browse", s.authed(s.handleBrowseChannels))
	m.HandleFunc("POST /api/v1/channels", s.authed(s.handleCreateChannel))
	m.HandleFunc("PATCH /api/v1/channels/{id}", s.authed(s.handleUpdateChannel))
	m.HandleFunc("POST /api/v1/channels/{id}/join", s.authed(s.handleJoinChannel))
	m.HandleFunc("POST /api/v1/channels/{id}/leave", s.authed(s.handleLeaveChannel))
	m.HandleFunc("GET /api/v1/channels/{id}/members", s.authed(s.handleListChannelMembers))
	m.HandleFunc("POST /api/v1/channels/{id}/members", s.authed(s.handleAddChannelMember))
	m.HandleFunc("DELETE /api/v1/channels/{id}/members/{pid}", s.authed(s.handleRemoveChannelMember))
	m.HandleFunc("POST /api/v1/channels/{id}/read", s.authed(s.handleMarkRead))
	m.HandleFunc("POST /api/v1/channels/{id}/mute", s.authed(s.handleMuteChannel))
	m.HandleFunc("GET /api/v1/channels/{id}/messages", s.authed(s.handleListMessages))
	m.HandleFunc("POST /api/v1/channels/{id}/messages", s.authed(s.handlePostMessage))

	m.HandleFunc("DELETE /api/v1/channels/{id}", s.authed(s.handleDeleteChannel))

	// personal sidebar sections (channel groups); all caller-scoped, no events
	m.HandleFunc("GET /api/v1/channel-groups", s.authed(s.handleListChannelGroups))
	m.HandleFunc("POST /api/v1/channel-groups", s.authed(s.handleCreateChannelGroup))
	m.HandleFunc("PATCH /api/v1/channel-groups/{id}", s.authed(s.handleUpdateChannelGroup))
	m.HandleFunc("DELETE /api/v1/channel-groups/{id}", s.authed(s.handleDeleteChannelGroup))
	m.HandleFunc("PUT /api/v1/channels/{id}/group", s.authed(s.handleSetChannelGroup))

	m.HandleFunc("GET /api/v1/messages/{id}", s.authed(s.handleGetMessage))
	m.HandleFunc("PATCH /api/v1/messages/{id}", s.authed(s.handleEditMessage))
	m.HandleFunc("DELETE /api/v1/messages/{id}", s.authed(s.handleDeleteMessage))
	m.HandleFunc("POST /api/v1/messages/{id}/reactions", s.authed(s.handleAddReaction))
	m.HandleFunc("DELETE /api/v1/messages/{id}/reactions/{emoji}", s.authed(s.handleRemoveReaction))
	m.HandleFunc("PUT /api/v1/messages/{id}/reactions", s.authed(s.handleReplaceReactions))
	m.HandleFunc("GET /api/v1/threads", s.authed(s.handleListRoomThreads))
	m.HandleFunc("GET /api/v1/threads/{id}", s.authed(s.handleGetThread))
	m.HandleFunc("GET /api/v1/channels/{id}/threads", s.authed(s.handleListThreads))
	m.HandleFunc("POST /api/v1/threads/{id}/read", s.authed(s.handleThreadRead))
	m.HandleFunc("POST /api/v1/threads/{id}/mute", s.authed(s.handleThreadMute))
	m.HandleFunc("POST /api/v1/threads/{id}/resolve", s.authed(s.handleThreadResolve))
	m.HandleFunc("POST /api/v1/threads/{id}/subscribe", s.authed(s.handleThreadSubscribe))
	m.HandleFunc("POST /api/v1/threads/{id}/leave", s.authed(s.handleThreadLeave))

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
		if strings.HasPrefix(token, "ses_") {
			// A session is a person, not a participant. Task 05 resolves the
			// participant from X-Room-Slug here; until then a session on a
			// room route is refused, and the act_ path below is untouched.
			if _, _, ok := s.sessionFromToken(w, r, token); !ok {
				return
			}
			writeErrCode(w, http.StatusForbidden, "no_room", "session tokens cannot use room routes yet")
			return
		}
		p, err := s.store.ParticipantByTokenHash(r.Context(), secrets.HashToken(token))
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		// any authenticated request counts as activity
		_ = s.store.TouchPresence(r.Context(), p.RoomID, p.ID)
		h(w, r, p)
	}
}

type sessionHandler func(w http.ResponseWriter, r *http.Request, u models.User)

// withSession admits only ses_ tokens: agents have no user. The user and the
// session also ride on the request context for anything deeper in the stack.
func (s *Server) withSession(h sessionHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if !strings.HasPrefix(token, "ses_") {
			writeErrCode(w, http.StatusUnauthorized, "session_required", "a login session is required")
			return
		}
		sess, u, ok := s.sessionFromToken(w, r, token)
		if !ok {
			return
		}
		ctx := context.WithValue(r.Context(), ctxKeyUser, u)
		ctx = context.WithValue(ctx, ctxKeySession, sess)
		h(w, r.WithContext(ctx), u)
	}
}

// sessionFromToken looks a ses_ token up and writes the 401 itself on a miss.
func (s *Server) sessionFromToken(w http.ResponseWriter, r *http.Request, token string) (models.Session, models.User, bool) {
	sess, u, err := s.store.SessionByTokenHash(r.Context(), secrets.HashToken(token), s.cfg.SessionTTL)
	if err != nil {
		writeErrCode(w, http.StatusUnauthorized, "session_invalid", "session expired")
		return sess, u, false
	}
	return sess, u, true
}

type ctxKey int

const (
	ctxKeyUser ctxKey = iota
	ctxKeySession
)

// UserFromContext returns the logged-in user set by withSession.
func UserFromContext(ctx context.Context) (models.User, bool) {
	u, ok := ctx.Value(ctxKeyUser).(models.User)
	return u, ok
}

// SessionFromContext returns the session set by withSession.
func SessionFromContext(ctx context.Context) (models.Session, bool) {
	sess, ok := ctx.Value(ctxKeySession).(models.Session)
	return sess, ok
}
