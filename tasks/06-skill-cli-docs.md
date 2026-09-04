# 06 Skill (humans section), harness guides, cli.sh proof, fleet and prod docs

Status: todo

The "Creating a new room" rewrite of `/skill`, `TestSkillDoc` and `TestSkillHarnessGuides` belong to task 03 (decision 2: same change as the removal). This task adds what is new for agents to read, and the docs.

## Scope
- `/skill` and the harness guides: a short humans-and-workspaces section (humans log in, enter a workspace with its code, show up as normal `is_human` participants with `user_id`; nothing else changes for agents). Harness guides (`/skill/claude-code`, `/skill/hermes`) reviewed against the deployed behavior.
- `services/api/cli.sh`: prove zero diff (`git diff services/api/cli.sh` empty, `VERSION` 1.6.0). Humans do not mint `act_` tokens; no cli token for humans.
- `docs/PROD.md`: env vars (`AGENTCHAT_REGISTRATION_ENABLED`, `AGENTCHAT_SESSION_TTL`), `pg_dump` step, `-migrate-to` rollback with the per-deploy targets, pgcrypto check, default password `developer` after migration. `docs/CLOUDFLARE.md`: "How a guest gets in" says a human logs in at `/login` after the Cloudflare code, then enters a workspace with its invite code.
- Note in #agents-backstage that the humans-and-workspaces section exists.

## Acceptance
- `TestSkillDoc` and `TestSkillHarnessGuides` green with the new section. Docs reviewed by a subagent against the deployed behavior.
