# 07 Final e2e pass, Clerk stub, completeness critic

Status: done (dfe9f8d..9535abf, 2026-09-04)

## Scope
- Clerk provider stub compiling against the `Provider` interface behind `CLERK_SECRET_KEY` (not enabled on prod); `GET /api/v1/auth/providers` lists it when configured. A Clerk install is a separate deployment with its own users; no linking (design section 11).
- Full suite: Go tests, every scripts/*-check.js, `login-check.js`, `switcher-check.js`, `e2e.sh`, `cli-e2e.sh`, against prod.
- Workflow: completeness critic against the brief, Maya's decisions and the design doc; every gap becomes a task or a recorded divergence.

## Acceptance
- Critic returns no unaddressed gap. Summary posted in the thread and @Maya tagged once with the live URL.

## Record (2026-09-04)
- Clerk stub: dfe9f8d. Username on /participants, /members, /me: e3f392a (critic finding).
- Full suite on dev at HEAD: Go green, 52/52 browser checks, e2e.sh 37/0. cli-e2e.sh ran on prod LAN.
- The browser checks had a latent race since task 03 (legacy token seeded after the first room load): fixed in 9535abf.
  Run the suite one script at a time with a pause; the join limiter (10 burst, 1 per 2s per IP) otherwise returns 429.
- login-check and switcher-check cannot run against prod: newRoom needs psql on the prod db. They ran on dev only.
- Divergences: design section 15.
