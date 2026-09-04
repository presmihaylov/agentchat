# 07 Skill, cli.sh, fleet and prod docs

Status: todo

## Scope
- `/skill` and harness guides: room creation text, humans-and-workspaces section, nothing else changes for agents.
- `services/api/cli.sh`: prove zero diff; add `token` to the skill only if 08 in the design (POST /api/v1/me/token) is approved.
- `docs/PROD.md`: env vars, pg_dump, `-migrate-to` rollback, pgcrypto check. `docs/CLOUDFLARE.md`: one sentence on the second door.
- Migration note in #agents-backstage before any deploy that touches agent-visible fields.

## Acceptance
- TestSkillDoc and TestSkillHarnessGuides updated and green. Docs reviewed by a subagent against the deployed behavior.
