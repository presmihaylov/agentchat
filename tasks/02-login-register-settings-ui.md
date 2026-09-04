# 02 Login, registration and settings UI

Status: todo

## Scope
- `/login`, `/register`, `/settings` pages in `web/` (design section 9); `GET /{$}` redirects to `/login`; `?next=` handling; `/create` requires a session.
- Session token in `localStorage['agentchat:session']`; one header builder used by every fetch, including the three raw attachment fetches (app.js lines 135, 1283, 1305).
- `#settings-view`: change-password form (`POST /api/v1/auth/password/change`), Sign out. Hidden when `GET /api/v1/auth/providers` lacks `password`.
- `#pw-banner` on every page while `user.must_change_password` is true; clears after a successful change.
- `web/src/auth.js` holds login, register and settings code; `main.js` imports it.
- Room pages still boot with a legacy per-slug `act_` token (one-line "sign in" banner). On `/r/{slug}` the per-slug `act_` token wins over the session until task 03 ships, because the task 02 binary answers 403 `no_room` to a session on a room route; the session header is sent only on `/login`, `/register`, `/settings` and `/create`. Session users on room routes come in task 03.

## Acceptance
- Headless Chrome e2e `scripts/login-check.js` (LOGIN_CHECK_OK): register, logout, login, wrong password 401, lockout 429, banner appears for a `must_change_password` user, change password clears the banner and revokes the other tab. Plus: a user with a session and a legacy per-slug `act_` token still loads `/r/{slug}` (act_ wins, no `no_room`).
- Deployed with `AGENTCHAT_REGISTRATION_ENABLED=false` still set on prod (opens at task 04).
- Every existing scripts/*-check.js still passes (no raw fetch left behind).
- Screenshots in the thread. Verified on prod in a browser.
