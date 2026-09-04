/* Account pages (/login, /register, /settings) and the two one-line banners.
   The session token is a human's login; agents and legacy humans keep act_ tokens. */

const SESSION_KEY = 'agentchat:session';
const $ = (id) => document.getElementById(id);
const path = location.pathname.replace(/\/+$/, '') || '/';

export const sessionToken = () => {
  try { return localStorage.getItem(SESSION_KEY) || null; } catch (e) { return null; }
};
const setSession = (tok) => localStorage.setItem(SESSION_KEY, tok);
export const clearSession = () => localStorage.removeItem(SESSION_KEY);

// the session header belongs on these pages only; room pages keep the act_
// token until task 03 (the server answers 403 no_room to a session there)
export const isAccountPage = ['/login', '/register', '/settings', '/create'].includes(path);

// ?next= may only point back into this origin. The string is resolved the
// way the browser will resolve it (the URL parser drops tab/CR/LF, so
// "/\t/evil" is "//evil") and the origin compared; a next that points at
// the login or register page itself would only loop
export const safeNext = (raw, origin = location.origin) => {
  if (typeof raw !== 'string' || raw[0] !== '/') return '/create';
  let u;
  try { u = new URL(raw, origin); } catch (e) { return '/create'; }
  if (u.origin !== origin) return '/create';
  const target = u.pathname.replace(/\/+$/, '') || '/';
  if (target === '/login' || target === '/register') return '/create';
  return u.pathname + u.search + u.hash;
};
const nextParam = () => safeNext(new URLSearchParams(location.search).get('next'));
export const loginURL = (next) => '/login?next=' + encodeURIComponent(next || (location.pathname + location.search));
// the sign-in / create-account cross links carry ?next= along
const keepNext = (id) => { $(id).href += location.search; };

// a dead session: forget it, and on the account pages go back to the login form
export const onSessionInvalid = () => {
  clearSession();
  if (path === '/login') return;
  if (isAccountPage) location.replace(loginURL());
};

const authApi = async (apiPath, opts = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  const tok = sessionToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const resp = await fetch(apiPath, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (e) { /* 204 */ }
  if (resp.ok) return data;
  const err = new Error((data && data.error) || ('HTTP ' + resp.status));
  err.status = resp.status;
  err.code = data && data.code;
  if (resp.status === 401 && err.code === 'session_invalid') onSessionInvalid();
  throw err;
};

const setBanner = (id, on) => {
  $(id).classList.toggle('hidden', !on);
  document.body.classList.toggle('has-banner', !$('pw-banner').classList.contains('hidden') || !$('signin-banner').classList.contains('hidden'));
};

// migration rule from the design: lower, whitespace runs to "-", strip the
// rest; an unusable result falls back to user-<8 hex of the participant id>
const deriveUsername = (p) => {
  const u = String(p.name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  if (/^[a-z0-9][a-z0-9_-]{1,31}$/.test(u)) return u;
  return 'user-' + String(p.id || '').replace(/-/g, '').slice(0, 8);
};

// room pages call this once they booted on a legacy act_ token with no session
export const showSignInBanner = (participant) => {
  if (sessionToken()) return;
  const el = $('signin-banner');
  el.innerHTML = '';
  el.appendChild(document.createTextNode('Sign in with your username (' + deriveUsername(participant) + ') to use this identity everywhere. '));
  const a = document.createElement('a');
  a.href = loginURL();
  a.textContent = 'Sign in';
  el.appendChild(a);
  setBanner('signin-banner', true);
};

const showErr = (id, msg) => { $(id).textContent = msg; $(id).classList.remove('hidden'); };
const hideErr = (id) => $(id).classList.add('hidden');

const loginErrorText = (e) => {
  if (e.status === 429) return e.message + ' (try again in a minute)';
  return e.message;
};

const providers = () => authApi('/api/v1/auth/providers').catch(() => ({ providers: ['password'], registration_enabled: true }));

// the pw-banner rides on every page that holds a session; it also refreshes
// after a successful change (must_change_password flips to false)
const refreshUser = async () => {
  if (!sessionToken()) { setBanner('pw-banner', false); return null; }
  try {
    const out = await authApi('/api/v1/user');
    setBanner('pw-banner', !!(out.user && out.user.must_change_password));
    return out.user;
  } catch (e) {
    setBanner('pw-banner', false);
    return null;
  }
};

const loginPage = async () => {
  $('login-view').classList.remove('hidden');
  const provs = await providers();
  if (!provs.registration_enabled) $('login-register-hint').classList.add('hidden');
  keepNext('login-register-link');
  const list = provs.providers || [];
  if (!list.includes('password')) $('login-form').querySelectorAll('label, button[type=submit]').forEach((el) => el.classList.add('hidden'));
  // an extra provider (Clerk) gets its redirect flow with its own task; the
  // button is the placeholder the design names
  for (const name of list.filter((n) => n !== 'password')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary';
    b.disabled = true;
    b.textContent = 'Sign in with ' + name;
    $('login-providers').appendChild(b);
  }
  // an already valid session skips the form
  if (sessionToken() && await refreshUser()) { location.replace(nextParam()); return; }
  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideErr('login-error');
    const btn = $('login-form').querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const out = await authApi('/api/v1/auth/password/login', {
        method: 'POST',
        body: { username: $('login-username').value.trim().toLowerCase(), password: $('login-password').value },
      });
      setSession(out.token);
      location.href = nextParam();
    } catch (e) {
      btn.disabled = false;
      showErr('login-error', loginErrorText(e));
    }
  });
};

const registerPage = async () => {
  refreshUser();
  const provs = await providers();
  if (!provs.registration_enabled || !(provs.providers || []).includes('password')) {
    $('register-closed').classList.remove('hidden');
    return;
  }
  $('register-view').classList.remove('hidden');
  keepNext('register-login-link');
  $('register-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideErr('register-error');
    const btn = $('register-form').querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const out = await authApi('/api/v1/auth/password/register', {
        method: 'POST',
        body: {
          username: $('register-username').value.trim().toLowerCase(),
          password: $('register-password').value,
          display_name: $('register-display').value.trim(),
        },
      });
      setSession(out.token);
      location.href = nextParam();
    } catch (e) {
      btn.disabled = false;
      showErr('register-error', e.message);
    }
  });
};

const signOut = async () => {
  try { await authApi('/api/v1/auth/logout', { method: 'POST' }); } catch (e) { /* already gone */ }
  clearSession();
  location.href = '/login';
};

const settingsPage = async () => {
  if (!sessionToken()) { location.replace(loginURL('/settings')); return; }
  const user = await refreshUser();
  if (!user) { location.replace(loginURL('/settings')); return; }
  const provs = await providers();
  if (!(provs.providers || []).includes('password')) {
    $('settings-nopw-username').textContent = user.username;
    $('settings-nopw').classList.remove('hidden');
    $('signout-nopw').onclick = signOut;
    return;
  }
  $('settings-username').textContent = user.username;
  $('settings-view').classList.remove('hidden');
  $('signout').onclick = signOut;
  $('pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideErr('pw-error');
    $('pw-ok').classList.add('hidden');
    if ($('pw-new').value !== $('pw-confirm').value) { showErr('pw-error', 'the new passwords do not match'); return; }
    const btn = $('pw-form').querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await authApi('/api/v1/auth/password/change', {
        method: 'POST',
        body: { current_password: $('pw-current').value, new_password: $('pw-new').value },
      });
      $('pw-form').reset();
      $('pw-ok').classList.remove('hidden');
      await refreshUser();
    } catch (e) {
      showErr('pw-error', loginErrorText(e));
    }
    btn.disabled = false;
  });
};

const pages = { '/login': loginPage, '/register': registerPage, '/settings': settingsPage };
if (pages[path]) {
  pages[path]().catch((e) => console.error('auth', e));
}
if (!pages[path]) {
  refreshUser();
}
