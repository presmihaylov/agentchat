# Workspaces and login: task tracker

Design: docs/workspaces-auth-design.md. Thread: 2196ade6 in #agentchat.
One file per task. Status is one of: todo, in-progress, review, deployed, done.
"done" means deployed to prod and verified in a real browser.
Every task ships on its own deploy. Never batch two tasks into one deploy.

| # | Task | Status |
|---|---|---|
| 01 | Auth provider interface, password provider, sessions | todo |
| 02 | Login and registration UI | todo |
| 03 | Workspace schema and room backfill | todo |
| 04 | User migration (humans to users, default password) | todo |
| 05 | Workspace switcher, room list, room entry | todo |
| 06 | Workspace invites and members | todo |
| 07 | Skill, cli.sh, fleet and prod docs | todo |
| 08 | Final e2e pass, Clerk readiness, completeness critic | todo |
| 09 | Deploy N+1: NOT NULL and legacy token retirement | todo |
