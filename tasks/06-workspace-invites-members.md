# 06 Workspace invites and members

Status: todo

## Scope
- `wsi_` tokens (32 random bytes, sha256 stored, 7 days, single use via UPDATE WHERE pending, max 50 pending), pending-email partial index.
- POST/GET/DELETE /api/v1/workspace/invites, GET /api/v1/workspace-invites/{token}/preview, POST /api/v1/workspace-invites/accept, register with `invite_token`, `/invite/{token}` page with sessionStorage handoff.
- Members list, DELETE member (self 400, last member 409, revokes participants in every room in one tx, room lock first, rooms in id order).
- Audit events in the same tx; GET /api/v1/workspace/audit-events.

## Acceptance
- Go tests: single use, expired, revoked, accept idempotent, remove member revokes participants, audit rows present.
- `scripts/wsinvite-check.js` (WSINVITE_CHECK_OK): create invite, signed-out visitor registers through it, lands in the workspace. Screenshots. Verified on prod.
