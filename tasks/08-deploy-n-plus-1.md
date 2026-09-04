# 08 Deploy N+1: retire legacy human tokens

Status: todo (blocked: at least 7 days after 04 is on prod and a full e2e pass on prod)

## Scope
- Migration 000027: `UPDATE participants SET token_hash = NULL WHERE is_human AND user_id IS NOT NULL` (design section 6). Down is a no-op; this deploy is the point of no return for human browser tokens.
- SPA: drop the legacy per-slug `act_` boot path and its "sign in" banner; a room page without a session goes to `/login?next=`.
- `docs/PROD.md`: note that rollback past 000027 does not restore human tokens.

## Acceptance
- Suite green. Prod: every human logs in with a session; every agent still online; no watcher gap; `git diff services/api/cli.sh` empty.
