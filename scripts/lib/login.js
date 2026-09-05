// Shared account helpers for the browser checks. Room creation needs a login
// session since task 03; every check makes its workspace through here.
const { execFileSync } = require('child_process');

const DB_URL = process.env.AGENTCHAT_DB_URL || 'postgres://agentchat:agentchat@localhost:5477/agentchat?sslmode=disable';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, p, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  const resp = await fetch(base + p, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  // register and login share the per-IP limiter (10 burst, 30/min) with
  // every /join the check itself makes
  if (resp.status === 429 && data.code === 'rate_limited') {
    await sleep(3000);
    return call(base, p, opts);
  }
  if (!resp.ok) throw new Error(p + ': ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

const uniqUser = () => 'u' + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1e6).toString(36);
const PASSWORD = 'correct horse battery';

// registerAndLogin returns a ses_ token for username (a fresh account, or a
// login when the name is already taken by an earlier run)
async function registerAndLogin(base, username = uniqUser(), displayName = '') {
  const body = { username, password: PASSWORD };
  if (displayName) body.display_name = displayName;
  try {
    return (await call(base, '/api/v1/auth/password/register', { method: 'POST', body })).token;
  } catch (e) {
    if (!e.message.includes('username_taken')) throw e;
  }
  return (await call(base, '/api/v1/auth/password/login', { method: 'POST', body: { username, password: PASSWORD } })).token;
}

// createRoom is POST /api/v1/rooms with a session: {room, join_url, invite_code}
const createRoom = (base, session, name) => call(base, '/api/v1/rooms', { method: 'POST', token: session, body: { name } });

// newRoom makes a workspace under a throwaway account and then vacates the
// creator's seat, so the first joiner becomes admin and the roster starts
// empty exactly as before task 03 (the Go tests do the same)
async function newRoom(base, name) {
  const session = await registerAndLogin(base);
  const out = await createRoom(base, session, name);
  if (!/^[0-9a-f-]{36}$/.test(out.room.id)) throw new Error('room id: ' + out.room.id);
  execFileSync('psql', [DB_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-c',
    `DELETE FROM participants WHERE room_id = '${out.room.id}' AND user_id IS NOT NULL`], { stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}

// loginPage signs a fresh account into a puppeteer page: register through the
// API, seed the session key on /login, then open opts.next (a room page, say).
// Returns the ses_ token so the caller can drive the API as the same user.
async function loginPage(page, base, username = uniqUser(), opts = {}) {
  const session = await registerAndLogin(base, username, opts.displayName || '');
  await page.goto(base + '/login', { waitUntil: 'networkidle2' });
  await page.evaluate((t) => localStorage.setItem('agentchat:session', t), session);
  if (opts.next) await page.goto(base + opts.next, { waitUntil: 'networkidle2' });
  return session;
}

// enterWithCode submits #enter-form with code and waits for the room to load
async function enterWithCode(page, code) {
  await page.waitForSelector('#enter-view:not(.hidden)', { timeout: 8000 });
  await page.$eval('#enter-code', (el) => { el.value = ''; });
  await page.type('#enter-code', code);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }),
    page.click('#enter-form button[type=submit]'),
  ]);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
}

// enterAs is the swept checks' one-liner: a fresh account named displayName
// signs in, opens the room page, meets #enter-view and gets in with code.
// Returns the ses_ token.
async function enterAs(page, base, slug, code, displayName) {
  const session = await loginPage(page, base, uniqUser(), { displayName, next: '/r/' + slug });
  await enterWithCode(page, code);
  return session;
}

// openWorkspace loads /w/<slug> with the session seeded and waits for the chat
async function openWorkspace(page, base, session, slug) {
  await page.goto(base + '/login', { waitUntil: 'networkidle2' });
  await page.evaluate((t) => localStorage.setItem('agentchat:session', t), session);
  await page.goto(base + '/w/' + slug, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
}

// switchTo picks slug in the workspace switcher; the switch is a full load of /w/<slug>
async function switchTo(page, slug) {
  await page.waitForSelector('#ws-switcher-wrap:not(.hidden)', { timeout: 8000 });
  await page.click('#ws-switcher');
  await page.waitForSelector('#ws-menu:not(.hidden)', { timeout: 4000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }),
    page.click('#ws-menu a[href="/w/' + slug + '"]'),
  ]);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
}

// openAsHuman boots a page as an existing human participant (a /join with
// is_human). Since 000027 the browser only knows sessions, so the participant
// is linked to a fresh account, as the backfill did, and the page opens
// /r/<slug> on that session. The act_ token keeps driving the API as the same
// identity. Returns the ses_ token. The session key is per browser profile:
// two humans on two pages need two browser contexts.
const humanSessions = new Map();
async function openAsHuman(page, base, slug, joined) {
  const p = joined.participant;
  if (!/^[0-9a-f-]{36}$/.test(p.id)) throw new Error('participant id: ' + p.id);
  let session = humanSessions.get(p.id);
  if (!session) {
    const username = uniqUser();
    session = await registerAndLogin(base, username, p.name);
    execFileSync('psql', [DB_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-c',
      `UPDATE participants SET user_id = (SELECT id FROM users WHERE username = '${username}') WHERE id = '${p.id}'`], { stdio: ['ignore', 'ignore', 'inherit'] });
    humanSessions.set(p.id, session);
  }
  await page.goto(base + '/login', { waitUntil: 'networkidle2' });
  await page.evaluate((t) => localStorage.setItem('agentchat:session', t), session);
  await page.goto(base + '/r/' + slug, { waitUntil: 'networkidle2' });
  return session;
}

module.exports = { call, registerAndLogin, createRoom, newRoom, loginPage, enterWithCode, enterAs, openWorkspace, openAsHuman, switchTo, uniqUser, PASSWORD, sleep };
