# Workspaces and login: task tracker

Design: docs/workspaces-auth-design.md. Thread: 2196ade6 in #agentchat.
Maya's decisions (2026-09-04) are section 13 of the design. A workspace is a room.
One file per task. Status is one of: todo, in-progress, review, deployed, done.
"done" means deployed to prod and verified in a real browser.
Every task ships on its own deploy. Never batch two tasks into one deploy.
Each deploy has its own rollback target (design section 7): 01 to 23, 03 to 24, 04 to 25.
"Deploy N" is the task 04 deploy (the backfill); "deploy N+1" is the task 08 deploy.
`AGENTCHAT_REGISTRATION_ENABLED=false` on the mini from the task 01 deploy until task 04
has run its backfill and verification queries.

| # | Task | Status |
|---|---|---|
| 01 | Auth provider interface, password provider, sessions | done |
| 02 | Login, registration and settings UI | done |
| 03 | Room users schema, session room entry, room creation requires login | done (a42c2ca) |
| 04 | User migration (humans to users, default password developer) | done |
| 05 | Workspace switcher | in-progress |
| 06 | Skill (humans section), harness guides, cli.sh proof, fleet and prod docs | todo |
| 07 | Final e2e pass, Clerk stub, completeness critic | todo |
| 08 | Deploy N+1: retire legacy human tokens | todo |
