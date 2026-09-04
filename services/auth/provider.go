// Package auth verifies login credentials. Every provider turns one credential
// into an Identity once; everything after that is a ses_ session.
package auth

import (
	"context"
	"encoding/json"
	"errors"
)

type Identity struct {
	Provider    string // "password" | "clerk"
	Subject     string // provider-unique id: the username for password, the Clerk user id for clerk
	Username    string // proposed login handle
	DisplayName string // "" when the provider has none; never overwrites an existing display_name
	Email       string // "" for password
}

// Provider verifies a credential once, at login.
type Provider interface {
	Name() string
	Authenticate(ctx context.Context, body json.RawMessage) (Identity, error)
}

// Registrar is implemented by providers that create accounts locally. Only password does.
type Registrar interface {
	Register(ctx context.Context, body json.RawMessage) (Identity, error)
}

var (
	ErrBadCredentials       = errors.New("invalid username or password")
	ErrLockedOut            = errors.New("too many failed attempts (5 in any 60s window), try again shortly")
	ErrRegistrationDisabled = errors.New("registration is disabled")
	ErrWeakPassword         = errors.New("password must be at least 8 characters")
	ErrPasswordTooLong      = errors.New("password must be at most 72 bytes")
	ErrBadUsername          = errors.New("username must be 2-32 lowercase letters, digits, - or _")
	ErrUsernameTaken        = errors.New("username is taken")
)

type Registry struct {
	byName map[string]Provider
	order  []string
}

func NewRegistry(ps ...Provider) *Registry {
	r := &Registry{byName: map[string]Provider{}}
	for _, p := range ps {
		r.byName[p.Name()] = p
		r.order = append(r.order, p.Name())
	}
	return r
}

func (r *Registry) Get(name string) (Provider, bool) {
	p, ok := r.byName[name]
	return p, ok
}

// Names returns providers in registration order; it drives the login page.
func (r *Registry) Names() []string { return append([]string(nil), r.order...) }
