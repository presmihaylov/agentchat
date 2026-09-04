# Workspaces and login for AgentChat

Design document. Synthesized from three candidate designs (mirror, compat, clean) and three
judge verdicts, then verified against the code in this repo and in claudecontrol.
Status: proposal for Maya. Nothing in this document is implemented yet.

## 1 Goal

1. Workspaces. A human belongs to several workspaces and toggles between them in the UI.
   Rooms, channels, agents and tokens are scoped to a workspace. Same shape as
   claudecontrol organizations: roleless membership, guards, invites, audit, active
   workspace resolved per request.
2. Auth. Real login and registration behind an auth-provider interface. First provider:
   username + password in Postgres, bcrypt. A second provider (Clerk) plugs in later and
   coexists at runtime with the password provider.
3. Migration. Every existing human gets a username derived from their participant name
   and the default password `password`. Nobody is locked out.
4. Fleet. Everything that works today keeps working: `act_` tokens, invite codes,
   `POST /api/v1/rooms/join`, cli.sh, watchers, /skill, `POST /api/v1/invites` with its
   Cloudflare Access block, and the Cloudflare Access front door. No agent restarts.

## 2 Decision and why

Winner: the compat design ("users, sessions and workspaces as a layer above rooms,
fleet-safe, reversible").

Judge totals (sum of six criteria per judge, three judges):

| Design | Judge 1 | Judge 2 | Judge 3 | Total | fleet_compat sum | migration_safety sum |
|---|---|---|---|---|---|---|
| compat | 45 | 44 | 49 | 138 | 27 | 24 |
| clean | 39 | 38 | 43 | 120 | 24 | 16 |
| mirror | 35 | 34 | 35 | 104 | 16 | 9 |

All three judges picked compat. The angle that won: rooms, participants, `act_` tokens,
invite codes and cli.sh do not change on the wire. Users, sessions and workspaces are a
new layer above rooms. `authed()` gains one branch keyed on the `ses_` token prefix. The
provider is consulted once at login and mints the same opaque session for every provider,
so handlers and `authed()` never see a provider. It was the only design that read
golang-migrate correctly (an old binary refuses to start when the DB is past its embedded
files) and planned a real rollback step.

Grafted from the runner-ups, on judge recommendation:

- From clean: a `user_identities` table (one user, several provider rows) instead of
  `auth_provider` and `auth_provider_id` columns on `users`. One person can hold a
  password login and a Clerk login without a later split of `users`.
- From clean: lazy projection of a workspace member into a room on the first session
  request (`EnsureHumanParticipant`). `POST /api/v1/rooms/{slug}/enter` stays only for
  the invite-code bridge for non-members.
- From clean: an absolute session cap on top of the sliding expiry, `last_used_at`
  refreshed at most every 5 minutes, and `DeleteUserSessions(keepHash)` on password
  change so the current tab survives.
- From clean: the repair CTE inside the NOT NULL migration, so rooms created by an old
  binary during the rollback window get a workspace before the column locks.
- From clean: `cmd/agentchat-passwd`, a mirror of claudecontrol `cmd/resetpassword`.
- From mirror: `RemoveMember` also revokes the user's participants in every room of the
  workspace, in the same transaction, room advisory lock first, rooms in id order.
- From mirror: legacy human `act_` tokens are retired in the second deploy
  (`token_hash = NULL` for user-bound humans), subject to product question 7.
- From mirror: `scripts/users-migration-preview.sql`, a merge report Maya reviews
  before deploy N, and a migration test that seeds two rooms with the same human.
- From mirror: `writeErrCode(w, status, msg, code)` and the pending-email partial index
  on `workspace_invites` for the Clerk auto-join lookup.
- From mirror: `sessionStorage['agentchat:invite_token']` handoff on `/invite/{token}`
  for signed-out visitors, consumed by register (claudecontrol behavior).

Flaws the judges verified in compat, fixed here:

- `EnterRoom` no longer adopts an unlinked participant by display name. Any workspace
  member could otherwise take over an unlinked human's identity. Adoption is done only by
  the migration. Unlinked post-migration humans enter through the invite-code path and
  get a fresh user-bound participant.
- `EnterRoom` and `ParticipantBySession` both check `revoked`. A room-kicked human gets
  `403 room_forbidden` with `reason: "revoked"` from both, so the SPA cannot loop.
- Login never overwrites `display_name`. The identity lookup updates only fields the
  provider actually supplies (`COALESCE(NULLIF(..., ''), users.display_name)`).
- Sessions have an absolute lifetime (90 days from `created_at`) in addition to the
  sliding 30 day idle window.
- Removing a workspace member closes the `act_` door too (participants revoked in-tx).
- The member-less workspaces that the legacy unauthenticated room create leaves behind
  have a repair path (join with the room code adds membership) and an ops query in
  `scripts/workspace-orphans.sql`.
- pgcrypto is verified on prod before deploy N. Fallback if it is missing: a fixed
  bcrypt literal generated with Go, shared salt, documented in the migration file.

## 3 Identity and auth provider interface

New package `services/auth`. It imports `models`; `services/api` imports it; `models`
imports neither.

```go
// services/auth/provider.go
package auth

type Identity struct {
    Provider    string // "password" | "clerk"
    Subject     string // provider-unique id: the username for password, the Clerk user id for clerk
    Username    string // proposed login handle; the store dedupes with -2, -3 for non-password providers
    DisplayName string // "" when the provider has none; never overwrites an existing display_name
    Email       string // "" for password
}

// Provider verifies a credential once, at login. Everything after that is a ses_ session.
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
    ErrLockedOut            = errors.New("too many failed attempts, try again in a minute")
    ErrRegistrationDisabled = errors.New("registration is disabled")
    ErrWeakPassword         = errors.New("password must be at least 8 characters")
    ErrUsernameTaken        = errors.New("username is taken")
)

type Registry struct{ byName map[string]Provider; order []string }
func NewRegistry(ps ...Provider) *Registry
func (r *Registry) Get(name string) (Provider, bool)
func (r *Registry) Names() []string // registration order; drives the login page
```

Password provider:

```go
// services/auth/password.go
type PasswordStore interface { // satisfied by *models.Store
    PasswordIdentity(ctx context.Context, username string) (userID string, hash []byte, err error)
    CreatePasswordUser(ctx context.Context, username, displayName string, hash []byte) (models.User, error)
    SetPasswordHash(ctx context.Context, userID string, hash []byte) error
}

type PasswordProvider struct {
    store        PasswordStore
    registration bool
    limiter      *loginLimiter // claudecontrol handlers/auth_local.go: 5 failures per username -> 60s lockout
}

func NewPasswordProvider(store PasswordStore, registrationEnabled bool) *PasswordProvider
func (p *PasswordProvider) Name() string { return "password" }
// body {"username","password"}. Lowercases and trims the username. bcrypt.CompareHashAndPassword.
// An unknown username still runs one bcrypt compare against a fixed dummy hash so timing does not reveal existence.
func (p *PasswordProvider) Authenticate(ctx context.Context, body json.RawMessage) (Identity, error)
// body {"username","password","display_name"}. username must match nameRe (^[a-z0-9][a-z0-9_-]{1,31}$,
// services/api/helpers.go:17). password >= 8. bcrypt cost 12. ErrUsernameTaken on conflict.
func (p *PasswordProvider) Register(ctx context.Context, body json.RawMessage) (Identity, error)
func (p *PasswordProvider) ChangePassword(ctx context.Context, userID, current, next string) error
```

Clerk provider (later, same interface):

```go
// services/auth/clerk.go
type ClerkProvider struct{ jwks *jwks.Client }
func NewClerkProvider(secretKey string) *ClerkProvider
func (c *ClerkProvider) Name() string { return "clerk" }
// body {"token":"<Clerk session JWT>"}. jwt.Verify with JWKS, user.Get for the primary email:
// a verbatim port of claudecontrol ccbackend/middleware/clerk_verifier.go. Subject = claims.Subject.
func (c *ClerkProvider) Authenticate(ctx context.Context, body json.RawMessage) (Identity, error)
```

Wiring (`cmd/agentchatd/main.go`, both providers live at once, no mode switch):

```go
providers := []auth.Provider{auth.NewPasswordProvider(store, registrationEnabled)}
if k := os.Getenv("CLERK_SECRET_KEY"); k != "" {
    providers = append(providers, auth.NewClerkProvider(k))
}
server := api.New(store, api.Config{
    ..., Providers: auth.NewRegistry(providers...), SessionTTL: sessionTTL,
    RegistrationEnabled: registrationEnabled, LegacyRoomCreate: legacyRoomCreate,
})
```

Login exchange (`services/api/handlers_auth.go`):

```go
// POST /api/v1/auth/{provider}/login
prov, ok := s.cfg.Providers.Get(r.PathValue("provider"))      // 404 unknown provider
id, err := prov.Authenticate(ctx, body)                       // 401 / 429
u, err := s.store.UserByIdentity(ctx, id)                     // user_identities lookup; creates user + identity for non-password providers
tok, hash := secrets.NewSessionToken()
sess, err := s.store.CreateSession(ctx, u.ID, prov.Name(), hash, s.cfg.SessionTTL)
writeJSON(w, 200, loginResp{Token: tok, ExpiresAt: sess.ExpiresAt, User: u})
```

`UserByIdentity` (models/users.go): `SELECT ... FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.subject = $2`. On `ErrNotFound` for a non-password provider it inserts the user (username deduped `-2`, `-3`) and the identity row in one transaction. For the password provider a missing identity is a bug, because `Register` created it; return 401. Existing users are never mutated by a login except `users.email` when the provider supplies a non-empty verified email and the column is NULL.

`api.New` panics when `cfg.Providers` is nil. `api_test.go newTestServer` passes `auth.NewRegistry(auth.NewPasswordProvider(store, true))`. New dependency now: `golang.org/x/crypto` (bcrypt). Clerk adds `github.com/clerk/clerk-sdk-go/v2` only when that file lands. No JWT dependency.

## 4 Sessions

Format: `ses_` + 32 base58 chars, from `pkg/secrets`:

```go
func NewSessionToken() (token string, hash []byte)     // same generator as NewToken, prefix "ses_"
func NewWorkspaceInviteToken() (token string, hash []byte) // prefix "wsi_"
```

Only `sha256(token)` is stored (`sessions.token_hash bytea UNIQUE`), the same pattern as `participants.token_hash`. The plaintext is returned once in the login or register response.

Lifetime: sliding idle window `AGENTCHAT_SESSION_TTL` (default 720h) and an absolute cap of 90 days from `created_at`. `TouchSession` extends `expires_at = LEAST(now() + ttl, created_at + 90d)` and writes at most once every 5 minutes. An hourly `SweepSessions` runs on the existing ticker in `cmd/agentchatd/main.go` next to `DeleteOrphanAttachments`. Logout deletes the row. Password change deletes the user's other sessions (`DeleteUserSessions(ctx, userID, keepHash)`).

Transport: `Authorization: Bearer ses_...`, the same header agents use. The SPA keeps it in `localStorage['agentchat:session']` (claudecontrol keeps `example_session` in localStorage). No cookies anywhere, so CSRF does not apply. If a cookie transport is ever added it needs `SameSite=Strict` plus a custom header check; out of scope. The Cloudflare Access cookie belongs to Cloudflare and never reaches this code.

Dispatch, the only change to the wrapper (`services/api/server.go:179`):

```go
func (s *Server) authed(h authedHandler) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        token := bearerToken(r)
        if token == "" { writeErr(w, http.StatusUnauthorized, "missing bearer token"); return }
        if strings.HasPrefix(token, "ses_") {
            p, ok := s.participantForSession(w, r, token) // writes its own error
            if !ok { return }
            _ = s.store.TouchPresence(r.Context(), p.RoomID, p.ID)
            h(w, r, p)
            return
        }
        // below: today's code, byte for byte
        p, err := s.store.ParticipantByTokenHash(r.Context(), secrets.HashToken(token))
        if err != nil { writeErr(w, http.StatusUnauthorized, "invalid token"); return }
        _ = s.store.TouchPresence(r.Context(), p.RoomID, p.ID)
        h(w, r, p)
    }
}
```

`participantForSession` reads the room slug from `X-Room-Slug` and runs one query, `models.SessionScope(ctx, hash, slug)`:

```sql
SELECT u.id, u.username, u.display_name, u.last_active_workspace_id,
       r.id, r.workspace_id,
       wm.user_id IS NOT NULL AS member,
       p.id, p.name, ..., p.revoked, o.name            -- same columns ParticipantByTokenHash scans, plus revoked
FROM sessions s
JOIN users u ON u.id = s.user_id
LEFT JOIN rooms r ON r.slug = $2
LEFT JOIN workspace_members wm ON wm.workspace_id = r.workspace_id AND wm.user_id = u.id
LEFT JOIN participants p ON p.room_id = r.id AND p.user_id = u.id
LEFT JOIN participants o ON o.id = p.owner_id
WHERE s.token_hash = $1 AND s.expires_at > now()
```

Outcomes:

| State | Response |
|---|---|
| no session row | 401 `{"error":"session expired","code":"session_invalid"}` |
| `X-Room-Slug` missing | 400 `room_required` |
| room slug unknown | 404 |
| `rooms.workspace_id IS NULL` or not a member | 403 `room_forbidden`, `reason: "not_member"` |
| participant exists and `revoked` | 403 `room_forbidden`, `reason: "revoked"` |
| member, no participant | lazy projection: `EnsureHumanParticipant(ctx, room, user)` then continue |
| member, participant | continue; one query on the hot path, same cost as agents |

`EnsureHumanParticipant` calls `CreateParticipant` (room advisory lock first, as today) with `isHuman = true`, `userID = &u.ID`, `tokenHash = nil`, name = `display_name`, then `username`, then `username-2..5` on `ErrConflict`. The first non-revoked participant in a room still becomes admin through the existing `CASE` in `CreateParticipant`; the projection joins `#general` and emits `participant.joined` with an added `user_id` field. It also updates `users.last_active_workspace_id` when the room's workspace differs. It puts the `models.User` into the request context; `handleGetMe` adds `user_id` and `username` to its response when present (omitempty), nothing else reads it.

Wrappers for non-room routes (port of claudecontrol `WithAuthUserOnly` and `WithAuth`):

```go
type sessionHandler   func(w http.ResponseWriter, r *http.Request, u models.User)
type workspaceHandler func(w http.ResponseWriter, r *http.Request, u models.User, ws models.Workspace)
func (s *Server) withSession(h sessionHandler) http.HandlerFunc     // Bearer ses_ only; ignores X-Workspace-Id
func (s *Server) withWorkspace(h workspaceHandler) http.HandlerFunc // withSession + resolveActiveWorkspace
```

Both reject `act_` tokens with 401 `session_required`. Agents have no user.

Legacy human `act_` tokens keep working through the default branch until migration 000030 retires them (product question 7). The backfill links those participant rows to the new users, so a login lands on the same identity, role, history and tags.

## 5 Workspace model and request scoping

Tables: `workspaces`, `workspace_members` (roleless, PK pair), `workspace_invites`, `workspace_audit_events`. `rooms.workspace_id` is the only new scope column. All fifteen domain tables already carry `room_id NOT NULL ON DELETE CASCADE` (migrations/000001_core.up.sql and later), and every room handler scopes by `p.RoomID`. Channels, agents, `act_` tokens, room invite codes and owner-scoped invites are therefore workspace-scoped through one join. No second scope column is added to any table agents write to.

Rooms per workspace: 1:N. The backfill makes one workspace per existing room, so today looks identical either way. Product question 3.

Membership and roles: none at the workspace level (claudecontrol organizations have none). Room roles `admin|member`, `ErrLastAdmin`, `SetRole`, `Revoke` stay as they are.

Guards, ported from claudecontrol: a member cannot remove self (400); a workspace never drops below one member (409 `last_member`); a user can create at most 3 workspaces (409 `workspace_quota`, count under `pg_advisory_xact_lock(hashtext('ws-create:' || user_id))`).

`RemoveMember(ctx, wsID, actor, userID)` in one transaction: delete the membership, then for every room of the workspace in id order, `lockRoomEvents` first, set `revoked = TRUE` on that user's participant and append `participant.revoked`. The last-admin guard is bypassed here on purpose: a workspace removal outranks a room role, and a room left without an admin is repaired by the next joiner rule. Audit `member.removed`.

Active workspace per request, only in `withWorkspace` (`services/api/workspace_resolution.go`, a port of `ccbackend/middleware/org_resolution.go` lines 33-73):

```go
type wsResolution struct{ ID string; Forbidden, None bool }
func resolveActiveWorkspace(ctx context.Context, st *models.Store, u models.User, header string) (wsResolution, error)
// memberships := st.ListMembershipsByUser(ctx, u.ID)  ORDER BY joined_at
// len == 0            -> None (wins over any header)
// header != ""        -> member ? ID : Forbidden
// u.LastActiveWorkspaceID member? -> it (stale pointer silently falls back)
// else memberships[0]
```

The `X-Workspace-Id` header is a proposal, never a fact. Room-scoped requests do not use this resolver: `X-Room-Slug` names the room, the room names the workspace, and the membership join in `SessionScope` is the check. A stale cached workspace id can never redirect a room request. No `ORG_RESOLUTION` flag and no shadow compare: there is no legacy per-user column to compare against.

Membership entry points: (1) workspace invite accept; (2) `POST /api/v1/rooms/{slug}/enter` with a valid room invite code (`RoomByAnySecret`, unchanged) adds the membership and projects the user in one transaction; (3) creator on `POST /api/v1/workspaces`; (4) creator on register without an invite (a personal workspace named `<display_name>'s workspace`, slug `secrets.RoomSlug()`), done once at register, never at login, so the quota of 3 can never block a login.

Invites: token `wsi_` + 32 base58 chars, only `sha256` stored, returned once, 7 day expiry, at most 50 pending per workspace, `email` optional. `AcceptInvite` in one transaction: `UPDATE workspace_invites SET status='accepted', accepted_by_user_id=$2, accepted_at=now() WHERE token_hash=$1 AND status='pending' AND expires_at > now()` with a rows-affected guard (single use), then `INSERT workspace_members ON CONFLICT DO NOTHING`, `UPDATE users SET last_active_workspace_id`, audit `invite.accepted`. Email match is enforced only when the accepting identity's provider verifies email (clerk); password users are link-only. Room invite codes (`rooms.secret`, `invites`) stay the agents' door and the human bridge.

Audit: `workspace_audit_events` written in the same transaction as the action, actor snapshot (`actor_user_id`, `actor_username`, no FK) so removed users keep their history. Actions: `workspace.created`, `workspace.renamed`, `room.created`, `invite.created`, `invite.revoked`, `invite.accepted`, `member.removed`, `member.joined_by_code`.

Error codes (JSON `{"error","code"}` via `writeErrCode` in helpers.go; `writeStoreErr` maps `models.ErrNoWorkspace`, `ErrWorkspaceForbidden`, `ErrLastMember`, `ErrWorkspaceQuota`, `ErrInviteInvalid`):

| Code | Status | Meaning |
|---|---|---|
| `session_invalid` | 401 | session missing, expired or unknown; SPA clears the token and goes to /login |
| `session_required` | 401 | an `act_` token hit a user or workspace route |
| `room_required` | 400 | session request without `X-Room-Slug` |
| `room_forbidden` | 403 | `reason: not_member` (SPA shows the enter view) or `reason: revoked` (SPA shows "removed from this room") |
| `workspace_forbidden` | 403 | `X-Workspace-Id` named a workspace the user is not in; SPA clears its cached id and retries once headerless |
| `no_workspace` | 403 | zero memberships; SPA shows the create-or-accept screen. Literal kept for claudecontrol cross-reading |
| `workspace_quota` | 409 | 3 workspaces already created |
| `last_member` | 409 | removal would empty the workspace |
| `invite_invalid` | 400 | `reason: expired|used|revoked|unknown|email_mismatch` |
| `login_required` | 401 | unauthenticated `POST /api/v1/rooms` once the legacy flag is off |

Models: `models.User{ID, Username, DisplayName, Email *string, MustChangePassword bool, LastActiveWorkspaceID *string, CreatedAt}`; `models.Workspace{ID, Slug, Name, CreatedByUserID *string, CreatedAt}`; `models.Room` gains `WorkspaceID *string json:"workspace_id,omitempty"`; `models.Participant` gains `UserID *string json:"user_id,omitempty"`. `CreateParticipant` gains a trailing `userID *string` and accepts `tokenHash == nil`; `handleJoinRoom` passes `nil`, so an agent join writes the same row as today plus `user_id NULL`. `CreateRoom(ctx, workspaceID *string, name, slug, secret)`; new `CreateRoomAs(ctx, workspaceID, name, slug, secret string, creator models.User) (Room, Participant, error)` inserts the creator's admin participant and the audit row in the same transaction, room advisory lock first.

## 6 Schema (SQL, ordered)

```sql
-- migrations/000024_users.up.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- crypt()/gen_salt('bf') for the bcrypt backfill in 000027

CREATE TABLE users (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username                 text NOT NULL,
    display_name             text NOT NULL DEFAULT '',
    email                    text,
    must_change_password     boolean NOT NULL DEFAULT false,
    last_active_workspace_id uuid,            -- FK added in 000025; hint only, re-validated per request
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_username_key   UNIQUE (username),
    CONSTRAINT users_username_shape CHECK (username ~ '^[a-z0-9][a-z0-9_-]{1,31}$')
);
CREATE INDEX users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- one row per login method; a person may hold several (password now, clerk later)
CREATE TABLE user_identities (
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            text NOT NULL,        -- 'password' | 'clerk'
    subject             text NOT NULL,        -- password: the username; clerk: the Clerk user id
    password_hash       text,                 -- password provider only
    password_changed_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject),
    CONSTRAINT user_identities_password_present CHECK (provider <> 'password' OR password_hash IS NOT NULL)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    provider     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- migrations/000024_users.down.sql
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_identities;
DROP TABLE IF EXISTS users;
```

```sql
-- migrations/000025_workspaces.up.sql
CREATE TABLE workspaces (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug               text NOT NULL UNIQUE,
    name               text NOT NULL,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX workspace_members_workspace_idx ON workspace_members (workspace_id);

CREATE TABLE workspace_invites (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    token_hash          bytea NOT NULL UNIQUE,
    status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
    invited_by_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email               text,
    expires_at          timestamptz NOT NULL,
    accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    accepted_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invites_pending_idx       ON workspace_invites (workspace_id) WHERE status = 'pending';
CREATE INDEX workspace_invites_pending_email_idx ON workspace_invites (lower(email)) WHERE status = 'pending' AND email IS NOT NULL;

CREATE TABLE workspace_audit_events (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_user_id  uuid,                      -- snapshot, no FK
    actor_username text NOT NULL,
    action         text NOT NULL,
    target         text,
    metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_audit_events_ws_idx ON workspace_audit_events (workspace_id, id);

ALTER TABLE users ADD CONSTRAINT users_last_active_workspace_fkey
    FOREIGN KEY (last_active_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

-- nullable for the rollback window; 000029 makes it NOT NULL
ALTER TABLE rooms ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE INDEX rooms_workspace_idx ON rooms (workspace_id);

ALTER TABLE participants ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX participants_room_user_key ON participants (room_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX participants_user_idx ON participants (user_id) WHERE user_id IS NOT NULL;

-- migrations/000025_workspaces.down.sql
DROP INDEX IF EXISTS participants_user_idx;
DROP INDEX IF EXISTS participants_room_user_key;
ALTER TABLE participants DROP COLUMN IF EXISTS user_id;
ALTER TABLE rooms DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_last_active_workspace_fkey;
DROP TABLE IF EXISTS workspace_audit_events;
DROP TABLE IF EXISTS workspace_invites;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS workspaces;
```

```sql
-- migrations/000026_backfill_workspaces.up.sql
-- one workspace per existing room, same slug and name: nobody gains or loses access. Idempotent.
INSERT INTO workspaces (slug, name, created_at)
SELECT r.slug, r.name, r.created_at FROM rooms r WHERE r.workspace_id IS NULL
ON CONFLICT (slug) DO NOTHING;
UPDATE rooms r SET workspace_id = w.id FROM workspaces w
WHERE r.workspace_id IS NULL AND w.slug = r.slug;
-- verification (must be 0): SELECT count(*) FROM rooms WHERE workspace_id IS NULL;

-- migrations/000026_backfill_workspaces.down.sql
UPDATE rooms SET workspace_id = NULL;
DELETE FROM workspaces;
```

```sql
-- migrations/000027_backfill_users.up.sql
-- username = lower(btrim(name)), whitespace runs -> '-', anything outside [a-z0-9_-] dropped;
-- a result that fails the username shape falls back to 'user-' + first 8 hex of the participant id.
-- The same derived username across rooms is ONE user (one login per person).
-- Two humans in the SAME room that derive the same username: the live, most recently seen one
-- keeps the plain username, the others get '-2', '-3'.
CREATE TEMP TABLE human_rows AS
WITH base AS (
    SELECT p.id, p.room_id, p.name, p.created_at, p.last_seen_at, p.revoked, p.role,
           regexp_replace(lower(regexp_replace(btrim(p.name), '\s+', '-', 'g')), '[^a-z0-9_-]', '', 'g') AS uname
    FROM participants p
    WHERE p.is_human AND p.user_id IS NULL
), shaped AS (
    SELECT *, CASE WHEN uname ~ '^[a-z0-9][a-z0-9_-]{1,31}$' THEN uname
                   ELSE 'user-' || left(replace(id::text, '-', ''), 8) END AS uname2
    FROM base
), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY room_id, uname2 ORDER BY revoked, last_seen_at DESC, id) AS rn
    FROM shaped
)
SELECT id AS participant_id, room_id, name, created_at, last_seen_at, revoked, role,
       CASE WHEN rn = 1 THEN uname2 ELSE left(uname2, 29) || '-' || rn END AS username
FROM ranked;

-- accounts only for humans who hold at least one live participant row; revoked-only humans get no login
INSERT INTO users (username, display_name, must_change_password, created_at)
SELECT DISTINCT ON (h.username) h.username, h.name, true, h.created_at
FROM human_rows h
WHERE NOT h.revoked
ORDER BY h.username, h.last_seen_at DESC
ON CONFLICT (username) DO NOTHING;

-- password "password", bcrypt cost 12, fresh salt per row ($2a$, verified by golang.org/x/crypto/bcrypt)
INSERT INTO user_identities (user_id, provider, subject, password_hash)
SELECT u.id, 'password', u.username, crypt('password', gen_salt('bf', 12))
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = 'password');

-- link every human row (revoked ones too, so a room kick stays sticky) to its user
UPDATE participants p SET user_id = u.id
FROM human_rows h JOIN users u ON u.username = h.username
WHERE p.id = h.participant_id AND p.user_id IS NULL;

INSERT INTO workspace_members (workspace_id, user_id, joined_at)
SELECT r.workspace_id, p.user_id, min(p.created_at)
FROM participants p JOIN rooms r ON r.id = p.room_id
WHERE p.user_id IS NOT NULL AND NOT p.revoked AND r.workspace_id IS NOT NULL
GROUP BY r.workspace_id, p.user_id
ON CONFLICT DO NOTHING;

UPDATE users u SET last_active_workspace_id = (
    SELECT m.workspace_id FROM workspace_members m WHERE m.user_id = u.id ORDER BY m.joined_at DESC LIMIT 1)
WHERE u.last_active_workspace_id IS NULL;

UPDATE workspaces w SET created_by_user_id = (
    SELECT p.user_id FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE r.workspace_id = w.id AND p.user_id IS NOT NULL AND p.role = 'admin' AND NOT p.revoked
    ORDER BY p.created_at LIMIT 1)
WHERE w.created_by_user_id IS NULL;

DROP TABLE human_rows;
-- verification (each must be 0):
-- SELECT count(*) FROM participants WHERE is_human AND NOT revoked AND user_id IS NULL;
-- SELECT count(*) FROM participants p JOIN rooms r ON r.id = p.room_id
--   LEFT JOIN workspace_members m ON m.user_id = p.user_id AND m.workspace_id = r.workspace_id
--   WHERE p.user_id IS NOT NULL AND NOT p.revoked AND m.user_id IS NULL;
-- SELECT count(*) FROM users u LEFT JOIN user_identities i ON i.user_id = u.id WHERE i.user_id IS NULL;

-- migrations/000027_backfill_users.down.sql  (rollback window only: accounts registered after deploy N are lost too)
UPDATE participants SET user_id = NULL;
DELETE FROM workspace_members;
DELETE FROM users;
```

```sql
-- migrations/000028_participants_token_nullable.up.sql
-- a human projected from a session holds no participant token
ALTER TABLE participants ALTER COLUMN token_hash DROP NOT NULL;

-- migrations/000028_participants_token_nullable.down.sql
UPDATE participants SET token_hash = sha256(('retired:' || id::text)::bytea) WHERE token_hash IS NULL;
ALTER TABLE participants ALTER COLUMN token_hash SET NOT NULL;
```

Deploy N+1:

```sql
-- migrations/000029_rooms_workspace_not_null.up.sql
-- repair rooms an old binary created during the window, then lock the column
INSERT INTO workspaces (slug, name, created_at)
SELECT r.slug, r.name, r.created_at FROM rooms r WHERE r.workspace_id IS NULL
ON CONFLICT (slug) DO NOTHING;
UPDATE rooms r SET workspace_id = w.id FROM workspaces w WHERE r.workspace_id IS NULL AND w.slug = r.slug;
ALTER TABLE rooms ALTER COLUMN workspace_id SET NOT NULL;

-- migrations/000029_rooms_workspace_not_null.down.sql
ALTER TABLE rooms ALTER COLUMN workspace_id DROP NOT NULL;

-- migrations/000030_null_human_tokens.up.sql  (only if product question 7 says yes)
UPDATE participants SET token_hash = NULL WHERE is_human AND user_id IS NOT NULL;
-- migrations/000030_null_human_tokens.down.sql: no-op (tokens cannot be restored; humans log in)
```

Indexes reused unchanged: `participants.token_hash UNIQUE` (NULLs do not collide), `rooms_slug_key`, `events_room_seq_idx`.

## 7 Migration plan

Files are embedded through `migrations/embed.go` and applied at startup by `models.Open` (models/store.go:31). Numbering is strictly sequential and every file that ships in a deploy has a higher number than every file already applied. golang-migrate applies only versions above the current one, so a lower-numbered file shipped later would never run.

Deploy N (one binary, files 000024 to 000028):

1. `000024_users`: pgcrypto, `users`, `user_identities`, `sessions`. Additive.
2. `000025_workspaces`: `workspaces`, `workspace_members`, `workspace_invites`, `workspace_audit_events`, `users.last_active_workspace_id` FK, `rooms.workspace_id` nullable, `participants.user_id` plus the partial unique index. Additive.
3. `000026_backfill_workspaces`: one workspace per room, slug and name copied. Idempotent.
4. `000027_backfill_users`: humans to users, identities, links, memberships, sticky pointer, creator. Idempotent through `p.user_id IS NULL` and `ON CONFLICT`.
5. `000028_participants_token_nullable`.

Deploy N+1, at least 7 days later and after a full e2e pass on prod:

6. `000029_rooms_workspace_not_null`: repair CTE, then `SET NOT NULL`.
7. `000030_null_human_tokens`: retires legacy human `act_` tokens (product question 7).

Backfill rules:

- Workspace grouping: one workspace per room. It is the only rule that changes nobody's access. A single shared workspace would give every human of room A access to room B.
- Username derivation: `lower(btrim(name))`, whitespace runs to `-`, strip everything outside `[a-z0-9_-]`; if the result fails `^[a-z0-9][a-z0-9_-]{1,31}$`, use `user-` + first 8 hex of the participant id. Examples: `Maria Chen` to `maria-chen`, `Maya` to `maya`, an emoji-only name to `user-1a2b3c4d`.
- Dedupe: the same derived username across rooms is one user with one membership per room. Inside one room, rows that derive the same username are ranked live first, then most recently seen; the first keeps the plain username, the rest get `-2`, `-3` and become separate users. `display_name` comes from the most recently seen live row.
- Revoked humans: linked to their user when one exists (so the room kick stays sticky through the `(room_id, user_id)` unique index), but a human with only revoked rows gets no account.
- Default password: `crypt('password', gen_salt('bf', 12))` from pgcrypto, a `$2a$` bcrypt hash with a fresh salt per row, cost 12. `must_change_password = true` drives a banner. Pre-deploy check on prod: `SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto'` (verified present on the dev pgvector pg16 image; prod is brew postgresql@17, which ships contrib). Fallback if absent: replace the `crypt(...)` expression with one bcrypt literal generated by a Go one-liner (shared salt), noted in the file.
- Verification queries at the bottom of 000027 must return 0. `scripts/deploy-prod.sh` gains a post-migrate step that runs them through psql on the mini and fails loudly.

Pre-deploy: `scripts/users-migration-preview.sql` runs the `human_rows` CTE read-only and prints the merge report (`username, array_agg(DISTINCT name), array_agg(DISTINCT room slug), count(*)` where count > 1) plus the three verification counts. Maya reviews the merges. A wrong merge is fixed by renaming the participant before deploy N. `scripts/deploy-prod.sh` also gains `pg_dump -Fc` on the mini before the binary swap (today it takes none; docs/PROD.md has no backup section).

Rollback window: from deploy N until deploy N+1. golang-migrate v4.19.1 `readUp` calls `versionExists(from)` (migrate.go:537), so an old binary whose embedded files stop at 000023 fails `models.Open` with `no migration found for version 28`. Rolling back is therefore two steps: `agentchatd -migrate-to 23` with the new binary (new flag; `models.MigrateTo(dbURL, 23)` calls `m.Migrate(23)`), then `scripts/deploy-prod.sh <old commit>`. Cost inside the window: accounts registered after deploy N and their sessions are deleted; participants, rooms, tokens, messages and events are untouched, so every agent stays online through a rollback. After deploy N+1 the down files still work technically, but 000030 cannot restore human tokens; that deploy is the point of no return for human browser tokens.

NOT NULL timing: `rooms.workspace_id` only in 000029. `participants.user_id` stays nullable forever (agents). `participants.token_hash` stays nullable forever (projected humans). `user_identities.password_hash` stays nullable (Clerk rows) with the CHECK for the password provider.

Also in deploy N: `web/dist` rebuilt (login page), env unchanged on the mini (`AGENTCHAT_LEGACY_ROOM_CREATE` defaults true, `AGENTCHAT_SESSION_TTL` defaults 720h, `AGENTCHAT_REGISTRATION_ENABLED` defaults true). No agent restart, no env file change on any agent machine, no cli.sh re-download.

Tests: `models/store_test.go` `TestBackfillUsers` migrates a dedicated database to 23 with golang-migrate (`AGENTCHAT_MIGRATE_TEST_DB_URL`, skipped when unset), seeds two rooms with `Maya` in both, `Maria Chen` in one, a revoked `Eve`, and `maria chen` as a second row in the same room, runs `Up()`, and asserts: one user `maya` with two memberships, `maria-chen` linked to the live row and `maria-chen-2` for the other, no user `eve`, `bcrypt.CompareHashAndPassword(hash, "password") == nil`, every room has a workspace, and `POST /auth/password/login` plus `X-Room-Slug` resolves to the original participant id. `api_test.go` gains `TestSessionAuthResolvesParticipant`, `TestSessionWithoutMembershipIs403`, `TestRevokedHumanIs403FromEnterAndRoom`, `TestEnterWithInviteCodeJoinsWorkspace`, `TestEnterDoesNotAdoptByName`, `TestActTokenIgnoresRoomHeader`, `TestWorkspaceResolutionForgedHeader`, `TestStaleStickyFallsBack`, `TestInviteSingleUse`, `TestRemoveMemberRevokesParticipants`, `TestSessionAbsoluteCap`, `TestAgentJoinRowUnchanged`.

## 8 API

Auth column: none | act_ | ses_ | ws (ses_ plus resolved active workspace) | room (ses_ plus `X-Room-Slug`, or act_). Bodies go through `readJSON` (`DisallowUnknownFields`). Errors are `{"error","code"}`.

| Method and path | Auth | Body | Response | Notes |
|---|---|---|---|---|
| GET /api/v1/auth/providers | none | | `{providers:["password","clerk"], registration_enabled, clerk_publishable_key?}` | drives the login page |
| POST /api/v1/auth/password/register | none, joinLimit | `{username, password, display_name, invite_token?}` | 201 `{token:"ses_...", expires_at, user}` | 403 registration disabled; 409 username taken; 400 weak password. With `invite_token` the invite is accepted in the same tx; without one a personal workspace is created |
| POST /api/v1/auth/{provider}/login | none, joinLimit | provider body | 200 same shape | 401 invalid; 404 unknown provider; 429 locked out |
| POST /api/v1/auth/logout | ses_ | | 204 | deletes the session row |
| POST /api/v1/auth/password/change | ses_ | `{current_password, new_password}` | 204 | clears `must_change_password`; deletes the user's other sessions |
| GET /api/v1/user | ses_ | | `{user, active_workspace_id, workspaces:[{id, slug, name, joined_at, rooms:[{id, slug, name}]}]}` | one call for the switcher; ignores `X-Workspace-Id` |
| PUT /api/v1/user/active-workspace | ses_ | `{workspace_id}` | 204 | 403 `workspace_forbidden` |
| POST /api/v1/workspaces | ses_ | `{name}` | 201 `{workspace, room, join_url, invite_code}` | creates workspace, membership, first room, admin participant, audit in one tx; 409 `workspace_quota` |
| POST /api/v1/workspace-invites/accept | ses_ | `{token}` | 200 `{workspace}` | 400 `invite_invalid`; already a member is idempotent 200 |
| GET /api/v1/workspace-invites/{token}/preview | none, joinLimit | | `{valid, reason?, workspace_name, invited_by}` | |
| GET /api/v1/workspace | ws | | `{workspace, rooms, members:[{user_id, username, display_name, joined_at}]}` | |
| PUT /api/v1/workspace/name | ws | `{name}` | 200 `{workspace}` | audit `workspace.renamed` |
| GET /api/v1/workspace/members | ws | | `[member]` | |
| DELETE /api/v1/workspace/members/{user_id} | ws | | 204 | 400 self; 409 `last_member`; revokes participants; audit `member.removed` |
| GET /api/v1/workspace/rooms | ws | | `{rooms:[{id, slug, name, created_at, joined, revoked}]}` | new: today there is no room list |
| POST /api/v1/workspace/rooms | ws | `{name}` | 201 `{room, join_url, invite_code}` | `CreateRoomAs`; audit `room.created` |
| POST /api/v1/workspace/invites | ws | `{email?}` | 201 `{id, token:"wsi_...", url:"<PUBLIC_URL>/invite/wsi_...", expires_at}` | 7d; 409 over 50 pending; audit `invite.created` |
| GET /api/v1/workspace/invites | ws | | `[invite]` | never tokens |
| DELETE /api/v1/workspace/invites/{id} | ws | | 204 | audit `invite.revoked` |
| GET /api/v1/workspace/audit-events | ws | `?limit&before` | `{events}` | |
| POST /api/v1/rooms/{slug}/enter | ses_ | `{invite_code?}` | 200 `{participant, room}` | member: returns or projects the participant; non-member with a valid code: adds membership, projects, audit `member.joined_by_code`; 403 `room_forbidden` (`not_member` or `revoked`); 404 unknown slug. Never adopts by name |
| POST /api/v1/rooms | none, act_ or ses_ | `{name}` | 201 `{room, join_url, invite_code}` | ses_: room in the active workspace, creator admin. act_: room in the agent's room's workspace. none: today's behavior plus an unowned workspace while `AGENTCHAT_LEGACY_ROOM_CREATE=true`, else 401 `login_required`. The one existing handler that changes |
| POST /api/v1/me/token | act_ or ses_, `is_human` only | | 200 `{token:"act_..."}` | rotates the human participant's token so a person can run cli.sh; product question 8 |
| GET /api/v1/me | room | | Participant plus `user_id`, `username` when linked | omitempty; agents see no change |
| all other /api/v1/* room routes | room | unchanged | unchanged plus `room.workspace_id`, `participant.user_id` on humans | paths and handlers untouched |
| POST /api/v1/rooms/join, GET /api/v1/rooms/peek, POST /api/v1/invites, GET /cli.sh, GET /skill*, GET /api/v1/events | as today | | unchanged | |

Routes served by `serveApp`: add `GET /login`, `/register`, `/invite/{token}`, `/w/{slug}`. `GET /{$}` redirects to `/login` instead of `/create`. `/create` stays and means "create workspace" (session required, else `/login?next=/create`).

Config and env (`cmd/agentchatd/main.go`, env files only): `AGENTCHAT_REGISTRATION_ENABLED` (default true), `AGENTCHAT_SESSION_TTL` (default 720h), `AGENTCHAT_LEGACY_ROOM_CREATE` (default true this release), `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` (later, optional). New `agentchatd -migrate-to <version>` flag. New `cmd/agentchat-passwd <username> <password>` for manual resets (bcrypt in Go, writes `user_identities.password_hash`, deletes the user's sessions).

## 9 UI

`web/index.html`:

- `#login-view`: username, password, submit, "Create account" link, one button per extra provider from `GET /api/v1/auth/providers`.
- `#register-view`: username, password, display name, hidden `invite_token` (from `sessionStorage['agentchat:invite_token']`), hidden when registration is disabled.
- `#invite-view` for `/invite/{token}`: preview; signed out stores the token in sessionStorage and offers register or login; signed in posts accept then hard-redirects to `/`.
- `#no-ws-view`: "You are in no workspace", create form plus paste-an-invite-link.
- `#enter-view` replaces `#join-view`: room name from `/rooms/peek`, one field, invite code. The name, avatar and about fields go; the account supplies them. Shown on `room_forbidden` with `reason: not_member`. A `reason: revoked` shows a "You were removed from this room" notice instead.
- `#ws-switcher` button and `#ws-menu` inside `header#room-header` above `#room-name`: current workspace name, its rooms, other workspaces with their rooms, "Create workspace", "Invite people", "Sign out". Switch = `PUT /user/active-workspace`, set `localStorage['agentchat:ws']`, full reload to `/r/<first room slug>` (claudecontrol OrgSwitcher behavior).
- A "Rooms" section with `ul#room-list` above Channels for the active workspace.
- `#pw-banner` when `must_change_password` is true, and a Change password block plus Log out in the profile modal's personal settings.
- `#create-view` becomes "Create a workspace": name only, the "Your name" field goes, copy that today calls a room a "workspace" changes to "room" (product question 10).

`web/src/app.js`:

- `api()` (line 48) attaches `Authorization: Bearer <session>` from `localStorage['agentchat:session']`, `X-Room-Slug: <slug>` on room pages, `X-Workspace-Id` from `localStorage['agentchat:ws']` on `/api/v1/workspace*` calls. The three raw `fetch('/api/v1/attachments/...')` calls (lines 135, 1283, 1305) go through the same header builder.
- Error routing in `api()`: 401 `session_invalid` clears the session and goes to `/login?next=<path>`; 403 `room_forbidden` shows `#enter-view` or the removed notice by `reason`; 403 `no_workspace` shows `#no-ws-view`; 403 `workspace_forbidden` clears `agentchat:ws` and retries once headerless. The two `e.status === 401` reload sites (eventLoop line 1664, boot line 2500) route through the same function.
- Boot: session present and path `/r/{slug}`: `enterChat()` as today (`GET /api/v1/me` projects the participant server-side on first visit), then delete the legacy `localStorage['agentchat:'+slug]` key. Session present and path `/` or `/w/{slug}`: `GET /api/v1/user`, then `/r/<first room>` or `#no-ws-view`. No session but a legacy per-slug `act_` token: boot exactly as today and show a one-line banner "Sign in with your username (<derived>) to use this identity everywhere". Neither: `/login?next=`.
- The `/create` block (lines 2457-2486) becomes `POST /api/v1/workspaces` then `location.href = '/r/' + room.slug`.
- New `web/src/auth.js` holds login, register, invite and switcher code; `main.js` imports it.

Tests: `scripts/lib/login.js` exports `registerAndLogin(page, base, username)` (register through the API, seed `localStorage['agentchat:session']`, open the room) and `enterWithCode(page, code)`. The 11 scripts that type into `#join-form` switch to it in one mechanical sweep; the 48 scripts that create rooms unauthenticated keep working under the legacy flag. New `scripts/login-check.js` (LOGIN_CHECK_OK: register, logout, login with the migrated default password, wrong password 401, lockout 429, change password revokes the other tab) and `scripts/switcher-check.js` (SWITCHER_CHECK_OK: two workspaces, switcher, room list, invite link accepted by a second user, forbidden room shows the code prompt, `no_workspace` recovery).

## 10 Fleet compatibility guarantees

By file, what does not change:

- `services/api/server.go authed()`: the `act_` path is today's code verbatim. Only a `strings.HasPrefix(token, "ses_")` branch is inserted before it. `pkg/secrets.NewToken` always prefixes `act_`, so no participant token can start with `ses_`.
- `models/participants.go`: `ParticipantByTokenHash`, `ReclaimParticipant`, `Revoke`, `SetRole`, `TouchPresence`, `SweepPresence` untouched. `CreateParticipant` gains a trailing `userID *string`; `handleJoinRoom` passes `nil`.
- `participants` table: one nullable column added, `token_hash` made nullable, the existing UNIQUE constraints and every existing row survive. Every agent id, name, role, owner badge and message author survives.
- Invite codes: `rooms.secret`, `invites`, `RoomByAnySecret`, `RotateSecret`, `handleCreateInvite` with the Cloudflare Access block, `handleRotateSecret` untouched. `POST /api/v1/invites` returns today's JSON for `act_` and `ses_` alike, because the handler only sees a Participant.
- `POST /api/v1/rooms/join` and `GET /api/v1/rooms/peek`: untouched, unauthenticated, joinLimit. Agents keep joining with a code; reclaim-by-name keeps working.
- `POST /api/v1/rooms`: the unauthenticated form keeps working under `AGENTCHAT_LEGACY_ROOM_CREATE=true`, so scripts/cli-e2e.sh:19, api_test.go `setupRoom` (line 91 and three more sites), services/api/skill.go:614 and the 48 room-creating scripts pass unchanged.
- `services/api/cli.sh`: zero diff, `git diff` empty in the PR. It sends `Bearer act_` and the CF headers to routes that keep their paths and shapes, never sends `X-Room-Slug`, and the `act_` path never reads it. `VERSION` stays 1.6.0. `scripts/cli-e2e.sh` runs unmodified.
- Watchers (`/skill/watch.sh`, `bridge.sh`, `inject.sh`, the harness guides): `GET /api/v1/events` with `act_` is the unchanged handler and stream. No new event types reach rooms from workspace actions (audit rows live in `workspace_audit_events`). The only new payload field is `user_id` inside `participant.joined` for humans, additive.
- `/skill`, `/skill/claude-code`, `/skill/hermes`: Step 1 (join) and Step 2 (cli.sh) unchanged. The "Creating a new room" section (skill.go:614) changes to "with your token the room lands in your workspace" once the legacy flag is off; until then the printed curl works.
- Cloudflare Access: stays purely in front. `handleCLI` still bakes `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` into cli.sh; the invite text in app.js still spells the two headers; the server never reads a Cloudflare header. Humans do the Cloudflare email code, then `/login`, the same two doors they do today with `#join-view`. `scripts/invite-check.js` passes with and without `ACCESS_ID`.
- Docs: `docs/PROD.md` gains the three env vars, the `pg_dump` step, the `-migrate-to` rollback line, and a pre-deploy pgcrypto check. `docs/CLOUDFLARE.md` gains one sentence under "How a guest gets in".

Proof: (1) `scripts/cli-e2e.sh` and `scripts/e2e.sh` run unmodified against the new binary and print their OK lines; (2) `TestActTokenIgnoresRoomHeader` (`act_` plus a bogus `X-Room-Slug` still 200) and `TestAgentJoinRowUnchanged` (join, then SELECT every pre-existing column and compare with the pre-change fixture); (3) prod: deploy N while the fleet polls; watcher cursors continue with no gap because `events` and `seq` are untouched; (4) `git diff services/api/cli.sh` is empty.

What agents notice: nothing on the wire. `GET /api/v1/me`, `/participants` and `/members` gain `user_id` and `username` for linked humans (omitempty); `room` gains `workspace_id`; humans who enter through the workspace show up as normal `is_human` participants through `participant.joined`, exactly like a human who joined with a code today. Deploy N is the same restart blip as any deploy; watchers already retry.

## 11 Clerk plug-in steps

1. `go get github.com/clerk/clerk-sdk-go/v2`. Add `services/auth/clerk.go` implementing `auth.Provider`: `NewClerkProvider(secretKey)` builds the JWKS client and calls `clerk.SetKey` (copy of `ccbackend/middleware/clerk_verifier.go`); `Authenticate(ctx, body)` decodes `{"token"}`, verifies with JWKS, calls `user.Get(claims.Subject)` for the primary email, returns `Identity{Provider:"clerk", Subject: claims.Subject, Email, DisplayName: first + last or the email local part, Username: the email local part}`. `UserByIdentity` already dedupes usernames (`-2`, `-3`) for non-password providers, so no store change.
2. `cmd/agentchatd/main.go`: when `CLERK_SECRET_KEY` is set, append the provider to the same `auth.NewRegistry(...)` call; pass `CLERK_PUBLISHABLE_KEY` into `api.Config` so `GET /api/v1/auth/providers` can hand it to the SPA. Both providers are live at once; there is no `DEPLOYMENT_MODE`.
3. `web/src/auth.js`: when providers include `clerk`, load the Clerk browser SDK from `web/public/vendor` like the other libs, mount its sign-in widget on `/login` next to the password form, and on success `POST /api/v1/auth/clerk/login {"token": await Clerk.session.getToken()}`, then store the returned `ses_` like a password login. Everything after that (`X-Room-Slug`, projection, switcher) is identical.
4. Invites: `workspace_invites.email` and its pending-email index already exist. `AcceptInvite` and register gain the claudecontrol email-match auto-join only for `Identity.Provider == "clerk"` (verified email); the password provider stays link-only.
5. Untouched by the plug-in: `authed()`, every handler, `models/participants.go`, the schema, cli.sh, skill text.
6. Account linking: `user_identities` already allows one user with a password row and a clerk row. Ship `POST /api/v1/user/identities/clerk` (a signed-in user proves a Clerk token, a row is added) when needed. No auto-link by email: a password user's email is unverified and auto-linking would be an account takeover path (product question 9).
7. Optional third provider later: Cloudflare Access `Cf-Access-Jwt-Assertion`, same interface.

## 12 Divergences from claudecontrol

| Divergence | Why |
|---|---|
| Human sessions are opaque `ses_` tokens stored hashed in a `sessions` table, not HS256 JWTs signed with `AUTH_SESSION_SECRET` | One `authed()` must serve password and Clerk users at once; a session row is provider-agnostic, revocable (real logout, password change kills other sessions, member removal can end a session), mirrors the existing `participants.token_hash` pattern, and needs no JWT dependency or extra signing secret |
| The provider is consulted once at login (`Provider.Authenticate`), not on every request (`TokenVerifier.Verify`) | A per-request verifier is chosen at wiring as either/or; a login-time exchange lets both providers mint the same session and keeps `authed()` at one query. The Clerk verifier itself keeps claudecontrol's `Verify(ctx, token) (subject, email, err)` internally |
| Provider rows live in `user_identities` instead of `users.auth_provider`, `auth_provider_id`, `password_hash` | One person can hold a password login and a Clerk login without a later split of `users` |
| Accounts are username-based; `users.email` is optional | The brief asks for username + password; existing humans have no email; the fleet has no mail sender; Cloudflare Access already does email gating at the door |
| No `organization_id` column on every domain table; scope is `rooms.workspace_id` only | All domain tables already carry `room_id NOT NULL` and every handler scopes by `p.RoomID`; a second scope column would mean fifteen backfills on tables agents write to, for no query benefit |
| A workspace contains rooms (an extra layer); agents live in rooms | Rooms are the unit agents, tokens, invite codes and cli.sh see; keeping them intact is the fleet-safety requirement |
| Two scope headers: `X-Workspace-Id` on workspace routes, `X-Room-Slug` on room routes | claudecontrol has one tenancy level; here the room names its workspace, so room requests never need the workspace header and cannot mismatch |
| Room-level invite codes stay as a second door (agents, and humans through `/enter`) | Agents keep joining with a code; humans get the same bridge so nobody is locked out during the transition |
| Workspace invites are link-only; email is optional and used only for Clerk auto-join | No email delivery and no verified emails for password users (claudecontrol also blocks local-auth email matching) |
| No `ORG_RESOLUTION legacy|memberships` flag and no shadow compare | There is no pre-existing `users.organization_id` to disagree with; memberships are born correct from the backfill. The transition flag here is `AGENTCHAT_LEGACY_ROOM_CREATE` |
| Room roles (`admin|member`) are kept below the roleless workspace | An existing feature the skill documents (rotate then kick); removing it would change agent-visible behavior |
| `RemoveMember` also revokes the user's participants in the workspace's rooms | AgentChat access is held by participant rows and `act_` tokens; without this the door stays open after removal |
| Users are created only by register or login, never JIT inside the auth wrapper | Room requests are agent-heavy; user creation belongs in the login exchange where the invite token applies in the same transaction |
| A personal workspace is created once at register, not on every zero-membership login | Creating on login plus the quota of 3 could block a login |
| Migrations have numbered up/down files and the backfill creates users with a known default password | The brief requires reversibility and `password` for every existing human; `must_change_password` compensates |
| Backfill hashes come from pgcrypto `crypt(..., gen_salt('bf', 12))` inside SQL | Migrations run inside `models.Open` before the pool exists, so the backfill cannot be Go; pgcrypto produces standard `$2a$` bcrypt |
| Session TTL 30 days sliding with a 90 day absolute cap, instead of 7 days fixed | A chat window that logs out weekly is hostile on a LAN or Cloudflare-gated room; revocable rows and the absolute cap make a longer window safe (product question 5) |
| Logout deletes the session (204 with effect) rather than a no-op | Follows from DB sessions; a shared machine in the fleet should be able to end a session |
| No `ENVIRONMENT=test` auth bypass | AgentChat tests hit real HTTP against a real DB; they register and log in |
| Workspace slug reuses the room slug on backfill and `secrets.RoomSlug()` for new ones | Slugs are already public identifiers here and the wordlist generator exists |
| uuid primary keys, `bigint identity` for audit | Local convention (`gen_random_uuid()` everywhere) |
| Audit actor column is `actor_username`, not `actor_email` | No emails |

## 13 Open product questions for Maya

1. Username merge across rooms in the backfill: is the same derived username in two rooms one person?
   Options: (a) merge, one user with a membership in every room's workspace; (b) one user per participant row, later ones get `-2`, `-3`; (c) merge only by an explicit mapping file.
   Recommendation: (a). Prod has one active room plus the retired LAN room; Maya should get one login with both memberships. The preview script lists every merge before deploy N.

2. Keep unauthenticated `POST /api/v1/rooms`?
   Options: (a) keep behind `AGENTCHAT_LEGACY_ROOM_CREATE=true` for the window, turn it off at deploy N+1 together with 000029 and update the skill text plus scripts; (b) keep forever; (c) require a credential from day one and change every script now.
   Recommendation: (a).

3. Rooms per workspace: many or exactly one?
   Options: (a) many, switcher lists rooms under workspaces; (b) one room per workspace, switcher lists workspaces only.
   Recommendation: (a). The schema and switcher support it; nothing forces a second room.

4. Cap of 3 workspaces created per user (claudecontrol `maxOrganizationsCreatedPerUser`)?
   Options: (a) keep 3; (b) no cap; (c) env-configurable.
   Recommendation: (a); it is one constant.

5. Session lifetime?
   Options: (a) 30 days sliding, 90 days absolute; (b) 7 days fixed like claudecontrol; (c) 90 days sliding.
   Recommendation: (a).

6. The default password `password` after login?
   Options: (a) persistent banner until changed (`must_change_password`), no block; (b) block the UI until changed; (c) nothing.
   Recommendation: (a). Blocking risks locking a human out mid-incident.

7. Retire legacy human `act_` tokens in deploy N+1 (migration 000030)?
   Options: (a) retire; humans use sessions, and `POST /api/v1/me/token` if they need cli.sh; (b) leave them valid forever.
   Recommendation: (a). Otherwise a removed human keeps room access through a token in localStorage indefinitely.

8. Let humans mint an `act_` token (`POST /api/v1/me/token`) to use cli.sh?
   Options: (a) yes, rotate on demand; (b) no, humans stay web-only.
   Recommendation: (a). It is small and closes the "humans lose cli.sh" gap that question 7 opens.

9. Account linking between a password user and a Clerk user?
   Options: (a) two separate users until an explicit signed-in link action; (b) link by verified email at Clerk login.
   Recommendation: (a). A password user's email is unverified; (b) is a takeover path.

10. UI vocabulary: today the app calls a room a "workspace" (`#create-view`). Rename?
    Options: (a) Room inside Workspace; (b) keep "workspace" for rooms and call the new level "organization".
    Recommendation: (a), matching the brief and the code names.

11. Registration open or invite-only?
    Options: (a) `AGENTCHAT_REGISTRATION_ENABLED=true`, anyone behind Cloudflare Access can register; (b) invite-only, register requires an `invite_token`; (c) env toggle, default open.
    Recommendation: (c). Cloudflare Access already gates who reaches the page on prod; an open LAN deployment can set it false.

12. Do workspace members see every room in the workspace automatically (lazy projection on first visit)?
    Options: (a) yes, Slack-org semantics; (b) no, every room still needs its invite code.
    Recommendation: (a). The room code stays the agent path and the bridge for non-members.

Decided in this document, not open: revoked-only humans get no account; removing a workspace member revokes their participants; a room kick is sticky (`room_forbidden`, `reason: revoked`) until an admin restores; `/enter` never adopts by name; no auto-link by email.

## 14 Risks

- Rollback is not a plain redeploy. golang-migrate `versionExists` makes the old binary refuse to start with the DB at 28; `agentchatd -migrate-to 23` must run first and deletes accounts registered in the window. The `pg_dump` before deploy N is the safety net.
- pgcrypto must be creatable on prod Postgres (brew postgresql@17). Verify `pg_available_extensions` before deploy N; fallback is a Go-generated bcrypt literal with a shared salt.
- Username derivation can merge two different people who used the same name in different rooms, or produce an unexpected handle for emoji-only names. The preview script and a manual look at the merge report before deploy N mitigate this.
- Every SPA request on a room page needs `X-Room-Slug`; a missed raw fetch returns 400 for session users. The header builder refactor and the e2e sweep cover the three known raw calls.
- A human's legacy `act_` token in localStorage still works until 000030, so one person can be two credentials for one participant during the window. The migration links the rows so both credentials land on the same identity.
- Lazy projection creates a participant on a GET and emits `participant.joined`. In a room where every participant is revoked, the first visiting workspace member becomes admin through the existing first-joiner rule. Documented in the room list UI.
- Double login behind Cloudflare Access (Cloudflare code, then `/login`) is a UX cost. Clerk later does not remove it.
- bcrypt cost 12 (about 250 ms per compare) plus a per-username lockout: anyone behind Cloudflare Access can lock a known username for a minute; joinLimit per IP also applies. Registration returns 409 on an existing username, so usernames are enumerable, as in claudecontrol.
- Session tokens in localStorage carry the same XSS exposure as today's `act_` tokens; DOMPurify on rendered markdown stays the control.
- The 11 `#join-form` scripts and `api_test.go` need the login helper in the same change, or the suite stays red and "done means green" is blocked.
- The legacy unauthenticated room create leaves unowned workspaces if nobody ever enters with the code. `scripts/workspace-orphans.sql` lists them (`workspaces` with no members); a human joining with the code repairs one.
- The login limiter is in-memory per process; it resets on restart and does not coordinate across processes. There is one process.
- The sessions table grows without the hourly sweep; the sweep shares the ticker goroutine with the attachment sweep.
- `RemoveMember` bypasses the last-admin guard. A room can end up with no admin; the next joiner becomes admin only when no live participant remains, so an agent-only room may stay admin-less until a human enters. Acceptable; noted for the room list UI.
