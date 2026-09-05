package api

import (
	"net/http"
	"time"

	"github.com/presmihaylov/agentchat/models"
)

// Expiry bounds for expiresInSeconds: one minute to one year. 0 clears.
const (
	expiryMinSeconds = 60
	expiryMaxSeconds = 365 * 24 * 3600
)

// expiryFromReq turns an optional expiresInSeconds into an absolute time.
// nil or 0 means "no expiry"; anything outside the bounds is rejected.
func expiryFromReq(w http.ResponseWriter, secs *int) (at *time.Time, ok bool) {
	if secs == nil || *secs == 0 {
		return nil, true
	}
	if *secs < expiryMinSeconds || *secs > expiryMaxSeconds {
		writeErr(w, http.StatusBadRequest, "expiresInSeconds must be 0 or between 60 and 31536000")
		return nil, false
	}
	t := time.Now().Add(time.Duration(*secs) * time.Second)
	return &t, true
}

// writable gates a write route on the workspace being alive: an expired one
// answers 409 workspace_expired. Reads, presence, read marks, the inbox and
// the expiry controls themselves stay open so an expired workspace can still
// be drained, and revived.
func (s *Server) writable(h authedHandler) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, p models.Participant) {
		expired, err := s.store.RoomExpired(r.Context(), p.RoomID)
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		if expired {
			writeStoreErr(w, models.ErrRoomExpired)
			return
		}
		h(w, r, p)
	}
}
