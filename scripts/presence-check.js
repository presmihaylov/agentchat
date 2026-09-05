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
  // rowOf: {online dot, below the divider} for one agent, revealing the offline section first
  const rowOf = (name) => page.evaluate((n) => {
    const t = document.querySelector('#participant-list li.offline-toggle.participant-leaf');
    if (t && t.textContent.includes('offline') && !t.textContent.includes('(0)') && !t.dataset.opened) { t.dataset.opened = '1'; t.click(); }
    const lis = [...document.querySelectorAll('#participant-list li')];
    const li = lis.find((x) => (x.querySelector('.pname') || {}).textContent === n);
    if (!li) return null;
    const dividerIdx = lis.findIndex((x) => x.classList.contains('offline-toggle') && x.classList.contains('participant-leaf'));
    const dot = li.querySelector('.dot');
    return { online: !!(dot && dot.classList.contains('online')), offlineClass: li.classList.contains('offline'), belowDivider: dividerIdx >= 0 && lis.indexOf(li) > dividerIdx };
  }, name);
  const waitRow = async (name, want) => {
    const until = Date.now() + 6000;
    let row = null;
    while (Date.now() < until) {
      row = await rowOf(name);
      if (row && row.online === want.online && row.belowDivider === want.belowDivider) return row;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(row)} (step ${step})`);
  };

  step = 'both online';
  await waitRow('parker', { online: true, belowDivider: false });
  await waitRow('stayer', { online: true, belowDivider: false });
  await shot('presence-before');

  step = 'parker offline';
  const off = await api('/api/v1/me/presence', { method: 'POST', token: parker.token, body: { status: 'offline' } });
  if (off.status !== 'offline') throw new Error('offline reply ' + JSON.stringify(off));
  // a plain request must not wake a parked agent
  await api('/api/v1/me/heartbeat', { method: 'POST', token: parker.token });
  const roster = await api('/api/v1/participants', { token: H.token });
  const p = roster.participants.find((x) => x.name === 'parker');
  if (!p || p.online !== false || p.presence !== 'offline' || p.declared_offline !== true) throw new Error('roster JSON: ' + JSON.stringify(p));
  await waitRow('parker', { online: false, belowDivider: true });
  await waitRow('stayer', { online: true, belowDivider: false });
  await page.evaluate(() => { const t = document.querySelector('#participant-list li.offline-toggle.participant-leaf'); if (t && !document.querySelector('#participant-list li.offline .pname')) t.click(); });
  await new Promise((r) => setTimeout(r, 300));
  await shot('presence-offline');

  step = 'mention queues';
  await api('/api/v1/channels/general/messages', { method: 'POST', token: H.token, body: { body: '@parker while you were parked' } });

  step = 'parker online';
  const on = await api('/api/v1/me/presence', { method: 'POST', token: parker.token, body: { status: 'online' } });
  if (on.was_offline !== true || on.events.length !== 1 || on.events[0].payload.body !== '@parker while you were parked') throw new Error('online batch: ' + JSON.stringify(on));
  await waitRow('parker', { online: true, belowDivider: false });
  await shot('presence-online');

  await browser.close();
  console.log('PRESENCE_CHECK_OK');
})().catch((e) => { console.error('PRESENCE_CHECK_FAIL: ' + e.message + ' (step ' + step + ')'); process.exit(1); });
