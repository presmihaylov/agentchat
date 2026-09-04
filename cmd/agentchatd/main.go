// Command agentchatd runs the AgentChat server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/services/api"
	"github.com/presmihaylov/agentchat/services/auth"
	"github.com/presmihaylov/agentchat/services/embed"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

// accessConfig reads the Cloudflare Access service token. CLOUDFLARE_TUNNEL=true
// without both halves is a misconfiguration that would ship a CLI nobody can
// use through the tunnel, so it refuses to start rather than serve a dud.
func accessConfig(getenv func(string) string) (id, secret string, err error) {
	if getenv("CLOUDFLARE_TUNNEL") != "true" {
		return "", "", nil
	}
	id, secret = getenv("CF_ACCESS_CLIENT_ID"), getenv("CF_ACCESS_CLIENT_SECRET")
	if id == "" || secret == "" {
		return "", "", errors.New("CLOUDFLARE_TUNNEL=true needs CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET")
	}
	return id, secret, nil
}

// authConfig reads the human-login knobs. Registration is on unless the
// operator says otherwise; the session TTL is a Go duration ("720h").
func authConfig(getenv func(string) string) (registration bool, ttl time.Duration, err error) {
	registration = true
	if v := getenv("AGENTCHAT_REGISTRATION_ENABLED"); v != "" {
		registration, err = strconv.ParseBool(v)
		if err != nil {
			return false, 0, fmt.Errorf("AGENTCHAT_REGISTRATION_ENABLED: %w", err)
		}
	}
	ttl = 720 * time.Hour
	if v := getenv("AGENTCHAT_SESSION_TTL"); v != "" {
		ttl, err = time.ParseDuration(v)
		if err != nil || ttl <= 0 {
			return false, 0, fmt.Errorf("AGENTCHAT_SESSION_TTL must be a positive duration like 720h, got %q", v)
		}
	}
	return registration, ttl, nil
}

func run() error {
	dbURL := os.Getenv("AGENTCHAT_DB_URL")
	if dbURL == "" {
		return errors.New("AGENTCHAT_DB_URL is required")
	}
	port := os.Getenv("AGENTCHAT_PORT")
	if port == "" {
		port = "8090"
	}
	publicURL := os.Getenv("AGENTCHAT_PUBLIC_URL")
	if publicURL == "" {
		publicURL = "http://localhost:" + port
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := models.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer store.Close()

	var embedder api.Embedder
	if key := os.Getenv("OPENAI_API_KEY"); key != "" {
		embedder = embed.NewOpenAI(key)
		go embed.NewWorker(store, embedder).Run(ctx)
		slog.Info("semantic search enabled", "model", embed.Model)
	} else {
		slog.Warn("OPENAI_API_KEY not set; semantic search disabled")
	}

	accessID, accessSecret, err := accessConfig(os.Getenv)
	if err != nil {
		return err
	}
	if accessID != "" {
		slog.Info("Cloudflare Access service token will be baked into /cli.sh")
	}

	registration, sessionTTL, err := authConfig(os.Getenv)
	if err != nil {
		return err
	}
	if !registration {
		slog.Info("self-service registration disabled")
	}

	server := api.New(store, api.Config{
		PublicURL:           publicURL,
		Embedder:            embedder,
		TrustProxy:          os.Getenv("AGENTCHAT_TRUST_PROXY") == "true",
		AccessClientID:      accessID,
		AccessClientSecret:  accessSecret,
		Providers:           auth.NewRegistry(auth.NewPasswordProvider(store, registration)),
		SessionTTL:          sessionTTL,
		RegistrationEnabled: registration,
	})

	// unreferenced uploads (posted but never attached) and dead login
	// sessions get swept periodically
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if n, err := store.DeleteOrphanAttachments(ctx); err != nil {
					slog.Error("orphan attachment sweep failed", "err", err)
				} else if n > 0 {
					slog.Info("swept orphan attachments", "count", n)
				}
				if n, err := store.SweepSessions(ctx); err != nil {
					slog.Error("session sweep failed", "err", err)
				} else if n > 0 {
					slog.Info("swept expired sessions", "count", n)
				}
			}
		}
	}()

	// passive presence: a participant whose heartbeat stopped goes offline
	// without any request, so a sweeper announces that transition as an event
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := store.SweepPresence(ctx); err != nil {
					slog.Error("presence sweep failed", "err", err)
				}
			}
		}
	}()

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// long-polls watch this context so they end promptly on SIGTERM
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	slog.Info("agentchatd listening", "addr", httpServer.Addr, "public_url", publicURL)
	if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	// ListenAndServe returns the moment Shutdown starts; wait for the actual
	// drain or in-flight responses get connection-reset on process exit
	<-shutdownDone
	return nil
}
