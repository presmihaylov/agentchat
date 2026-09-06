// E2E for the live-updates principle: two real browser windows side by side.
// Window A (watcher) must see, with NO refresh: a message posted from window B,
// a presence dot flip both ways, and window B must survive being removed from a
// channel it is viewing (sidebar drops it, view bounces to #general).
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/liveupdate-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';

async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

async function joinAs(browser, slug, code, name) {
  // own incognito context per window: a shared profile would restore the
  // first join's localStorage token and skip the join form
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await enterAs(page, SERVER, slug, code, name);
  await page.waitForFunction(() => document.querySelectorAll('#channel-list li').length > 0);
  return page;
}

// sidebar presence for a participant, by name. An agent's row stays in its
// list whether it is online or offline, so a missing row is a bug, not a state.
const dotState = (name) => `(() => {
  const li = [...document.querySelectorAll('#participant-list li')]
    .find((l) => l.querySelector('.pname') && l.querySelector('.pname').textContent === ${JSON.stringify(name)});
  if (!li) return 'missing';
  return li.querySelector('.dot').classList.contains('online') ? 'online' : 'offline';
})()`;

(async () => {
  const created = await newRoom(SERVER, 'liveupdate check');
  const slug = created.room.slug;
  // bot joins first, so it is the admin
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'livebot', description: 't', avatar: '🤖' } });

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const A = await joinAs(browser, slug, created.invite_code, 'watcherA');
  const B = await joinAs(browser, slug, created.invite_code, 'actorB');

  // 1) a message typed in B appears in A with no refresh
  await B.type('#composer-input', 'live hello from B');
  await B.keyboard.press('Enter');
  await A.waitForFunction(() =>
    [...document.querySelectorAll('#messages .msg')].some((m) => m.textContent.includes('live hello from B')),
    { timeout: 10000 });
  console.log('message sync live: OK');

  // 2) removal: bot creates #ops, adds B; B enters it; bot removes B.
  //    B's sidebar must drop the channel live and bounce the view to #general.
  await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'ops' } });
  await api('/api/v1/channels/ops/members', { method: 'POST', token: bot.token, body: { participant: 'actorB' } });
  await B.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li')].some((l) => l.textContent.includes('ops')),
    { timeout: 10000 });
  await B.evaluate(() =>
    [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.includes('ops')).click());
  await B.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('ops'), { timeout: 5000 });

  await api('/api/v1/channels/ops/members/actorB', { method: 'DELETE', token: bot.token });
  await B.waitForFunction(() =>
    !([...document.querySelectorAll('#channel-list li')].some((l) => l.textContent.includes('ops')))
    && document.querySelector('#channel-title').textContent.includes('general'),
    { timeout: 10000 });
  console.log('own removal live (sidebar drop + bounce to #general): OK');

  // 3) presence: bot goes offline -> A's dot greys live; any bot request -> green again
  await A.waitForFunction(`${dotState('livebot')} === 'online'`, { timeout: 10000 });
  await api('/api/v1/me/offline', { method: 'POST', token: bot.token });
  await A.waitForFunction(`${dotState('livebot')} === 'offline'`, { timeout: 10000 });
  await api('/api/v1/me', { token: bot.token });
  await A.waitForFunction(`${dotState('livebot')} === 'online'`, { timeout: 10000 });
  console.log('presence dot live both ways: OK');

  await browser.close();
  console.log('LIVEUPDATE_CHECK_OK');
})().catch((e) => { console.error('LIVEUPDATE_CHECK_FAIL:', e.message); process.exit(1); });
