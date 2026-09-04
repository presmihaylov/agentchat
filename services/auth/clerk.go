package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const ProviderClerk = "clerk"

// ErrProviderNotImplemented: the provider is wired but cannot verify yet.
var ErrProviderNotImplemented = errors.New("clerk login is not implemented yet")

// ClerkProvider is the stub for a Clerk deployment (design section 11): its
// own install, its own users, no linking to password accounts. It is listed
// when CLERK_SECRET_KEY is set and refuses every login until the JWKS
// verifier lands, so a misconfigured install can never let a token through.
type ClerkProvider struct {
	secretKey string
}

func NewClerkProvider(secretKey string) *ClerkProvider {
	return &ClerkProvider{secretKey: secretKey}
}

func (c *ClerkProvider) Name() string { return ProviderClerk }

type clerkCreds struct {
	Token string `json:"token"`
}

// Authenticate will verify a Clerk session JWT against the instance JWKS and
// map claims.Subject to the identity. Until then an empty token is a bad
// credential and everything else is refused as not implemented.
func (c *ClerkProvider) Authenticate(_ context.Context, body json.RawMessage) (Identity, error) {
	var creds clerkCreds
	if err := json.Unmarshal(body, &creds); err != nil {
		return Identity{}, fmt.Errorf("invalid JSON body: %w", err)
	}
	if strings.TrimSpace(creds.Token) == "" {
		return Identity{}, ErrBadCredentials
	}
	return Identity{}, ErrProviderNotImplemented
}
