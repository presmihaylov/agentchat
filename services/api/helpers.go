package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"

	"github.com/presmihaylov/agentchat/models"
)

const maxBodyBytes = 64 * 1024

var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,31}$`)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeStoreErr maps model errors onto HTTP statuses.
func writeStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, models.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not found")
	case errors.Is(err, models.ErrConflict):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, models.ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, models.ErrLastAdmin):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, models.ErrArchived):
		writeErr(w, http.StatusConflict, err.Error())
	default:
		slog.Error("internal error", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(h, "Bearer "); ok {
		return t
	}
	return ""
}

// clientIP keys the rate limiter. X-Forwarded-For is client-controlled, so it
// is only honored when the operator says a trusted proxy sets it — otherwise
// forged headers would give every request a fresh bucket.
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// reservedNames cannot be participant names: "me" is an API alias and the
// rest are broadcast mention keywords.
var reservedNames = map[string]bool{"me": true, "channel": true, "here": true, "everyone": true, "all": true}

func validName(name string) bool { return nameRe.MatchString(name) }

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// isUUID guards lookups so non-uuid refs fall through to 404 instead of a pg cast error.
func isUUID(s string) bool { return uuidRe.MatchString(strings.ToLower(s)) }
