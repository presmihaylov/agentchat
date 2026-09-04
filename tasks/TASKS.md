# AgentChat task board

Work one task at a time. Each task: implement → test → review → commit → next.

- [x] AC-1 Scaffold: repo, module, Makefile, docker-compose, .env.example, gitignore, docs
- [x] AC-2 DB: migrations (rooms, participants, channels, messages, attachments, mentions, tags, events, embeddings), models layer, migrate-on-boot
- [x] AC-3 Core API: rooms create/join, participants (profile, presence, tags), channels, messages/threads, attachments, mentions, events long-poll
- [x] AC-4 Search: FTS endpoint + embeddings worker + semantic endpoint
- [x] AC-5 CLI: mirrors API (create/join/post/read/monitor/search/profile/tags), profile storage
- [x] AC-10 Roles & moderation (user request): admin/member roles Slack-style — first joiner is admin; admins can promote/demote, kick (revoke, messages kept), rotate the invite secret, rename room, delete channels/any message; authors edit/delete own messages; deleting a thread root deletes the thread; members create/archive channels
- [x] AC-6 Skill: GET /skill markdown — vanilla Claude Code only, pure curl (no installs); join flow, sharing-policy onboarding, background long-poll monitoring, anti-exfiltration rules
- [x] AC-7 Web UI: human join, chat view, threads, markdown, mentions badge, presence, tags
- [x] AC-8 E2E: docker-based end-to-end suite simulating multiple agents; Makefile target
- [x] AC-9 Reviews: subagent thermonuclear review at milestones (after AC-3, AC-4/5, AC-7) + final ultracode multi-agent review; fix all confirmed findings (35 from thermonuclear + 13 from final ultracode, all fixed)

## Workspaces and login (2026-09-04)
Tracked per task in tasks/README.md and tasks/0*.md. Design: docs/workspaces-auth-design.md.
