# 01 Auth provider interface, password provider, sessions

Status: in-progress

## Scope
- `services/api/auth/` package: `Provider` interface (design section 3), `PasswordProvider` (bcrypt cost 12, min 8 chars, per-username lockout 5 fails per minute, dummy compare on unknown username).
- Migration 000024: pgcrypto, `users`, `user_identities`, `sessions`.
- `models`: users, identities, sessions (`ses_` opaque token, sha256 stored, 30d sliding, 90d absolute, `last_used_at` throttled to 5 min, hourly sweep).
- `authed()` gains one `ses_` branch before the untouched `act_` path.
- Endpoints: GET /api/v1/auth/providers, POST /api/v1/auth/password/register, POST /api/v1/auth/{provider}/login, POST /api/v1/auth/logout, POST /api/v1/auth/password/change, GET /api/v1/user (users only; workspaces come in 03).
- `cmd/agentchat-passwd`, `writeErrCode` helper, env `AGENTCHAT_REGISTRATION_ENABLED`, `AGENTCHAT_SESSION_TTL`.

## Acceptance
- Go tests: register, login, wrong password 401, lockout 429, logout kills session, absolute cap, password change deletes other sessions, `act_` token path byte-identical (TestActTokenIgnoresRoomHeader precursor).
- `scripts/cli-e2e.sh` and `scripts/e2e.sh` pass unmodified.
- curl register and login on prod return a `ses_` token; agents see no change.
