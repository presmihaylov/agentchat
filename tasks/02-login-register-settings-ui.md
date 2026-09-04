# 02 Login, registration and settings UI

Status: todo

## Scope
- `/login`, `/register`, `/settings` pages in `web/` (design section 9); `GET /{$}` redirects to `/login`; `?next=` handling; `/create` requires a session.
- Session token in `localStorage['agentchat:session']`; one header builder used by every fetch, including the three raw attachment fetches in app.js. Rule until task 03 ships: on `/r/{slug}` the per-slug legacy `act_` token wins over the session and the session header is never sent, because the task 02 binary answers 403 `no_room` to a session on a room route. The session header goes only to `/login`, `/register`, `/settings` and `/create`.
- `#settings-view`: change-password form (`POST /api/v1/auth/password/change`), Sign out. Hidden when `GET /api/v1/auth/providers` lacks `password`.
- `#pw-banner` on every page while `user.must_change_password` is true; clears after a successful change.
- `web/src/auth.js` holds login, register and settings code; `main.js` imports it.
- Room pages still boot with a legacy per-slug `act_` token when no session exists (one-line "sign in" banner). Session users on room routes come in task 03.

## Acceptance
- Headless Chrome e2e `scripts/login-check.js` (LOGIN_CHECK_OK): register, logout, login, wrong password 401, lockout 429, banner appears for a `must_change_password` user, change password clears the banner and revokes the other tab, and a user with both a session and a legacy `act_` token for a slug opens `/r/{slug}` with the `act_` token (no 403 `no_room`).
- Every existing scripts/*-check.js still passes (no raw fetch left behind).
- Screenshots in the thread. Verified on prod in a browser (registration is closed on prod; the test user comes from `agentchat-passwd`).
