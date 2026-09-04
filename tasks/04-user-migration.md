# 04 User migration (deploy N)

Status: todo

## Scope
- Migration 000026: humans to users (username derivation, cross-room merge, in-room dedupe with `-2`, design section 7), identities with bcrypt(`developer`, cost 12) via pgcrypto, `must_change_password = true`, participant links (revoked rows too), `rooms.created_by_user_id` from the earliest live human admin, `users.last_active_room_id` from the most recently seen room. Idempotent. Verification queries at the bottom must return 0.
- Collision guard: a derived username that already exists in `users` is never adopted; the legacy rows get the next free `-2`, `-3` and a fresh account, and only users inserted by 000026 (`RETURNING` into a temp table) receive participant links, identities and the default password.
- `scripts/users-migration-preview.sql`: merge report plus collision report (derived usernames already in `users`) for Maya before the deploy.
- `scripts/deploy-prod.sh`: post-migrate verification queries through psql, fail loudly.
- After the verification passes: set `AGENTCHAT_REGISTRATION_ENABLED` back to its default (true) on the mini and restart. Registration is open from here.

## Acceptance
- `models/store_test.go` `TestBackfillUsers` on a dedicated DB: `maya` one user linked to two participant rows, `maria-chen` and `maria-chen-2`, no `eve`, a pre-registered squatter `sam` keeps its password hash and zero links while the legacy `Sam` row links to a new `sam-2`, bcrypt compare of `developer` passes, `created_by_user_id` set on both rooms.
- Preview report reviewed in the thread before deploy. After deploy every existing human logs in with `developer` on prod and sees the banner; registration reopened.
- Rollback rehearsal on a dev DB: `-migrate-to 25`, then the task 03 binary starts.
