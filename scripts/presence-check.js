// E2E (task 21): an agent that declares itself offline sinks into the roster's
// offline section with a grey dot, live, and comes back up on online.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/presence-check.js
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || '';

async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

let step = 'start';
(async () => {
  const created = await newRoom(SERVER, 'presence check');
  const slug = created.room.slug, code = created.invite_code;
  const H = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'boss', avatar: '🧑', is_human: true } });
  const owned = await api('/api/v1/invites', { method: 'POST', token: H.token, body: { bind_owner: true } });
  const parker = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: owned.join_url, name: 'parker', avatar: '🤖' } });
  const stayer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: owned.join_url, name: 'stayer', avatar: '🤖' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  const shot = async (name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: `${OUT}/${name}.png` }); } };

  step = 'open';
  await openAsHuman(page, SERVER, slug, H);
  await page.waitForSelector('#participant-list li', { timeout: 6000 });
  step = 'expand boss';
  await page.waitForFunction(() => [...document.querySelectorAll('#participant-list li .pname')].some((e) => e.textContent === 'boss'), { timeout: 4000 });
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#participant-list li')].find((x) => (x.querySelector('.pname') || {}).textContent === 'boss');
    (li.querySelector('.p-toggle') || li).click();
  });
  // the kid list under a human is ONE flat list: online agents first,
  // then the offline ones with a grey dot. No sub-header, no second toggle.
  const kidRows = () => page.evaluate(() => {
    const lis = [...document.querySelectorAll('#participant-list li')];
    const start = lis.findIndex((x) => (x.querySelector('.pname') || {}).textContent === 'boss');
    const rows = [];
    // stop at the next top-level row, but keep any divider found among the kids
    // so a re-added sub-header shows up as a row instead of truncating the scan
    for (let i = start + 1; i < lis.length; i++) {
      const li = lis[i];
      if (!li.classList.contains('participant-leaf') && !li.classList.contains('offline-toggle')) break;
      if (li.classList.contains('addagent-row')) continue;
      const dot = li.querySelector('.dot');
      rows.push({ name: (li.querySelector('.pname') || {}).textContent, online: !!(dot && dot.classList.contains('online')), divider: li.classList.contains('offline-toggle') });
    }
    return rows;
  });
  // flat = no divider among the kids, and every online kid before every offline one
  const flat = (rows) => {
    if (rows.some((r) => r.divider)) throw new Error('a divider came back inside the kid list: ' + JSON.stringify(rows));
    const firstOffline = rows.findIndex((r) => !r.online);
    if (firstOffline >= 0 && rows.slice(firstOffline).some((r) => r.online)) throw new Error('kids are not online-first: ' + JSON.stringify(rows));
  };
  const waitRow = async (name, want) => {
    const until = Date.now() + 6000;
    let rows = [];
    while (Date.now() < until) {
      rows = await kidRows();
      const row = rows.find((r) => r.name === name);
      if (row && row.online === want.online) { flat(rows); return row; }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(rows)} (step ${step})`);
  };

  step = 'both online';
  await waitRow('parker', { online: true });
  await waitRow('stayer', { online: true });
  await shot('presence-before');

  step = 'parker offline';
  const off = await api('/api/v1/me/presence', { method: 'POST', token: parker.token, body: { status: 'offline' } });
  if (off.status !== 'offline') throw new Error('offline reply ' + JSON.stringify(off));
  // a plain request must not wake a parked agent
  await api('/api/v1/me/heartbeat', { method: 'POST', token: parker.token });
  const roster = await api('/api/v1/participants', { token: H.token });
  const p = roster.participants.find((x) => x.name === 'parker');
  if (!p || p.online !== false || p.presence !== 'offline' || p.declared_offline !== true) throw new Error('roster JSON: ' + JSON.stringify(p));
  await waitRow('parker', { online: false });
  await waitRow('stayer', { online: true });
  const order = await kidRows();
  if (order.length !== 2 || order[0].name !== 'stayer' || order[1].name !== 'parker') throw new Error('offline kid must sit last in the same list: ' + JSON.stringify(order));
  await new Promise((r) => setTimeout(r, 300));
  await shot('presence-offline');

  step = 'mention queues';
  await api('/api/v1/channels/general/messages', { method: 'POST', token: H.token, body: { body: '@parker while you were parked' } });

  step = 'parker online';
  const on = await api('/api/v1/me/presence', { method: 'POST', token: parker.token, body: { status: 'online' } });
  if (on.was_offline !== true || on.events.length !== 1 || on.events[0].payload.body !== '@parker while you were parked') throw new Error('online batch: ' + JSON.stringify(on));
  await waitRow('parker', { online: true });
  await shot('presence-online');

  step = 'top-level offline section';
  // the one divider that stays: a human with no online agent sinks below it
  const ghost = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'ghost', avatar: '\u{1F47B}', is_human: true } });
  await api('/api/v1/me/offline', { method: 'POST', token: ghost.token });
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('#participant-list li.offline-toggle')];
    const shown = [...document.querySelectorAll('#participant-list li .pname')].some((e) => e.textContent === 'ghost');
    return t.length === 1 && /offline \(1\)/.test(t[0].textContent) && !shown;
  }, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#participant-list li.offline-toggle').click());
  await page.waitForFunction(() => [...document.querySelectorAll('#participant-list li .pname')].some((e) => e.textContent === 'ghost'), { timeout: 4000 });
  await shot('presence-root-offline');

  await browser.close();
  console.log('PRESENCE_CHECK_OK');
})().catch((e) => { console.error('PRESENCE_CHECK_FAIL: ' + e.message + ' (step ' + step + ')'); process.exit(1); });
