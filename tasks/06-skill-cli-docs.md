# 06 Skill, cli.sh, fleet and prod docs

Status: todo

## Scope
- `/skill` and the harness guides: a short humans-and-workspaces section (humans log in, enter a workspace with its invite code, show up as normal `is_human` participants; a `/join` cannot reclaim them). The "Creating a new room" rewrite already shipped in task 03; nothing else changes for agents.
- `services/api/cli.sh`: prove zero diff (`git diff services/api/cli.sh` empty, `VERSION` 1.6.0). Humans do not mint `act_` tokens; no cli token for humans.
- `docs/PROD.md`: env vars (`AGENTCHAT_REGISTRATION_ENABLED`, `AGENTCHAT_SESSION_TTL`), `pg_dump` step, `-migrate-to` rollback with the per-deploy targets, pgcrypto check, default password `developer` after migration. `docs/CLOUDFLARE.md`: "How a guest gets in" says a human logs in at `/login` after the Cloudflare code, then enters a workspace with its invite code.
- Note in #agents-backstage that the humans-and-workspaces section exists.

## Acceptance
- `TestSkillDoc` and `TestSkillHarnessGuides` green with the new section. Docs reviewed by a subagent against the deployed behavior.
