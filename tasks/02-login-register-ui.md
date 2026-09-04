# 02 Login and registration UI

Status: todo

## Scope
- `/login`, `/register` pages in `web/`; `GET /{$}` redirects to `/login`; `?next=` handling.
- Session token in localStorage, header builder used by every fetch (no raw fetches left).
- `must_change_password` banner with an inline change form.
- Existing `#join-view` (invite code) stays for the bridge in 05.

## Acceptance
- Headless Chrome e2e `scripts/login-check.js` (LOGIN_CHECK_OK): register, logout, login, wrong password error, banner appears and clears after change.
- Screenshots in the thread. Verified on prod in a browser.
