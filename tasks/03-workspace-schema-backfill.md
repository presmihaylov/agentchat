# 03 Workspace schema and room backfill

Status: todo

## Scope
- Migrations 000025 (workspaces, workspace_members, workspace_invites, workspace_audit_events, `users.last_active_workspace_id`, `rooms.workspace_id` nullable, `participants.user_id` + partial unique index) and 000026 (one workspace per existing room, idempotent).
- `agentchatd -migrate-to <version>` flag and `models.MigrateTo`.
- `scripts/deploy-prod.sh`: `pg_dump -Fc` before the binary swap, post-migrate verification queries.
- Active workspace resolution: sticky pointer, `X-Workspace-Id` proposal validated against membership, oldest membership fallback; error codes `workspace_forbidden` 403, `workspace_mismatch` 409, `no_workspace` 403.
- POST /api/v1/workspaces (cap 3 per creator), GET /api/v1/workspace, PUT name, GET /api/v1/user now lists workspaces and rooms.
- POST /api/v1/rooms: `ses_` puts the room in the active workspace; `act_` in the agent room workspace; unauthenticated keeps working behind `AGENTCHAT_LEGACY_ROOM_CREATE=true` (default true).

## Acceptance
- Go tests: forged `X-Workspace-Id` 403, stale sticky falls back, quota 409, room create in all three auth modes, every existing room has a workspace after Up().
- `scripts/cli-e2e.sh` and `scripts/e2e.sh` pass unmodified; `git diff services/api/cli.sh` empty.
- Prod: rollback rehearsal on a dev DB (`-migrate-to 23` then old binary starts).
