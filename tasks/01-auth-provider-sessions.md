# 01 Auth provider interface, password provider, sessions

Status: done (2ddc377 + 514c27d, prod 514c27d, registration closed until task 04)

## Scope
- `services/auth/` package: `Provider` interface (design section 3), `PasswordProvider` (bcrypt cost 12, min 8 chars, per-username lockout 5 fails per minute, dummy compare on unknown username).
- Migration 000024: pgcrypto, `users`, `user_identities`, `sessions`. The last-active column is `users.last_active_room_id` (JSON key `last_active_workspace_id`, Go field added in 03).
- `models`: users, identities, sessions (`ses_` opaque token, sha256 stored, 30d sliding, 90d absolute, `last_used_at` throttled to 5 min, hourly sweep).
- `authed()` gains one `ses_` branch before the untouched `act_` path (answers 403 `no_room` until 03).
- Endpoints: GET /api/v1/auth/providers, POST /api/v1/auth/password/register, POST /api/v1/auth/{provider}/login, POST /api/v1/auth/logout, POST /api/v1/auth/password/change, GET /api/v1/user (users only; workspaces come in 05).
- `cmd/agentchat-passwd`, `writeErrCode` helper, env `AGENTCHAT_REGISTRATION_ENABLED`, `AGENTCHAT_SESSION_TTL`.
- Rollback tooling for this and every later deploy: `agentchatd -migrate-to <version>` flag and `models.MigrateTo`; `scripts/deploy-prod.sh` takes `pg_dump -Fc` on the mini before the binary swap.
- Pre-deploy check on the mini: `SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto'`; 000024 runs `CREATE EXTENSION` and there is no fallback.

## Acceptance
- Go tests: register, login, wrong password 401, lockout 429, logout kills session, absolute cap, password change deletes other sessions, `act_` token path byte-identical (TestActTokenIgnoresRoomHeader precursor).
- `scripts/cli-e2e.sh` and `scripts/e2e.sh` pass unmodified.
- Rollback rehearsal on a dev DB: `-migrate-to 23`, then the old binary starts.
- Deployed with `AGENTCHAT_REGISTRATION_ENABLED=false` in the mini's env file (stays false until task 04 has run). curl login on prod returns a `ses_` token for a user created with `agentchat-passwd`; register answers 403 `registration_disabled`; agents see no change.
