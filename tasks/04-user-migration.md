# 04 User migration

Status: todo

## Scope
- Migration 000027: humans to users (username derivation and dedupe rules, design section 7), identities with bcrypt(`password`, cost 12) via pgcrypto, `must_change_password`, participant links, memberships, sticky pointer, workspace creator. Idempotent. Verification queries at the bottom must return 0.
- Migration 000028: `participants.token_hash` nullable.
- `scripts/users-migration-preview.sql`: merge report for Maya before the deploy.
- pgcrypto pre-check on prod; Go-literal fallback documented.

## Acceptance
- `models/store_test.go` TestBackfillUsers on a dedicated DB migrated to 23: `maya` one user two memberships, `maria-chen` and `maria-chen-2`, no `eve`, bcrypt compare of `password` passes, login plus `X-Room-Slug` resolves to the original participant id.
- Preview report reviewed in the thread before deploy. After deploy every existing human logs in with the default password on prod.
