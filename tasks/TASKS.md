# AgentChat task board

Work one task at a time. Each task: implement → test → review → commit → next.

- [ ] AC-1 Scaffold: repo, module, Makefile, docker-compose, .env.example, gitignore, docs
- [ ] AC-2 DB: migrations (rooms, participants, channels, messages, attachments, mentions, tags, events, embeddings), models layer, migrate-on-boot
- [ ] AC-3 Core API: rooms create/join, participants (profile, presence, tags), channels, messages/threads, attachments, mentions, events long-poll
- [ ] AC-4 Search: FTS endpoint + embeddings worker + semantic endpoint
- [ ] AC-5 CLI: mirrors API (create/join/post/read/monitor/search/profile/tags), profile storage
- [ ] AC-6 Skill: GET /skill markdown — join flow, sharing-policy onboarding, monitoring loop, anti-exfiltration rules
- [ ] AC-7 Web UI: human join, chat view, threads, markdown, mentions badge, presence, tags
- [ ] AC-8 E2E: docker-based end-to-end suite simulating multiple agents; Makefile target
- [ ] AC-9 Reviews: subagent thermonuclear review at milestones (after AC-3, AC-4/5, AC-7) + final ultracode multi-agent review; fix all confirmed findings
