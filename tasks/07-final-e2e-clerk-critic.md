# 07 Final e2e pass, Clerk stub, completeness critic

Status: todo

## Scope
- Clerk provider stub compiling against the `Provider` interface behind `CLERK_SECRET_KEY` (not enabled on prod); `GET /api/v1/auth/providers` lists it when configured. A Clerk install is a separate deployment with its own users; no linking (design section 11).
- Full suite: Go tests, every scripts/*-check.js, `login-check.js`, `switcher-check.js`, `e2e.sh`, `cli-e2e.sh`, against prod.
- Workflow: completeness critic against the brief, Maya's decisions and the design doc; every gap becomes a task or a recorded divergence.

## Acceptance
- Critic returns no unaddressed gap. Summary posted in the thread and @Maya tagged once with the live URL.
