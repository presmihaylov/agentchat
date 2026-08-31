// Command agentchatd runs the AgentChat server.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/presmihaylov/agentchat/models"
	"github.com/presmihaylov/agentchat/services/api"
	"github.com/presmihaylov/agentchat/services/embed"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
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

	server := api.New(store, api.Config{PublicURL: publicURL, Embedder: embedder})

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	slog.Info("agentchatd listening", "addr", httpServer.Addr, "public_url", publicURL)
	if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
