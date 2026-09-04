# 04 User migration (deploy N)

Status: todo

## Scope
- Migration 000026: humans to users (username derivation, cross-room merge, in-room dedupe with `-2`, design section 7), identities with bcrypt(`developer`, cost 12) via pgcrypto, `must_change_password = true`, participant links (revoked rows too), `rooms.created_by_user_id` from the earliest live human admin, `users.last_active_room_id` from the most recently seen room. Idempotent through `p.user_id IS NULL`. Verification queries at the bottom must return 0.
- Collision guard: a derived username that already exists in `users` gets the next free `-2`, `-3` and a new account; the file collects the ids it inserts into a temp table (`RETURNING`) and links participants and identities only to those. No `ON CONFLICT`; a residual collision aborts the deploy.
- `scripts/users-migration-preview.sql`: merge report plus the collision report (derived usernames already in `users`) for Maya before the deploy.
- `scripts/deploy-prod.sh`: post-migrate verification queries through psql, fail loudly.
- Prod env: `AGENTCHAT_REGISTRATION_ENABLED` flips from false to true after the verification queries pass. This deploy is "deploy N"; the 7 day window for task 08 starts here.

## Acceptance
- `models/store_test.go` `TestBackfillUsers` on a dedicated DB migrated to 25: `maya` one user linked to two participant rows, `maria-chen` and `maria-chen-2`, no `eve`, bcrypt compare of `developer` passes, `created_by_user_id` set on both rooms; a pre-registered `sam` (registered through the API before `Up()`) keeps its own password hash and zero participant links while the legacy `Sam` row links to a new user `sam-2`.
- Preview report reviewed in the thread before deploy. After deploy every existing human logs in with `developer` on prod and sees the banner. Registration is open on prod after this deploy.
- Rollback rehearsal on a dev DB: `-migrate-to 25`, then the task 03 binary starts.
