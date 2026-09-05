// E2E for the browse-channels affordance: it sits beside the + on the CHANNELS
// header at the same optical weight, and the list is the whole public map —
// channels you are in are grayed with "already a member" and offer no Join,
// while private channels stay hidden.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/browse-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
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
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await newRoom(SERVER, 'browse check');
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'browsebot', description: 't' } });
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', is_human: true } });
  await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'open-one', topic: 'joinable' } });
  const mine = await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'mine', topic: 'viewer is in this' } });
  await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'hidden', topic: 'private', private: true } });
  await api('/api/v1/channels/mine/members', { method: 'POST', token: bot.token, body: { participant: 'viewer' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
    await openAsHuman(page, SERVER, slug, viewer);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  // placement: the browse button sits on the CHANNELS header row, immediately
  // left of +, on the same baseline and at a comparable rendered size
  const geom = await page.evaluate(() => {
    // DOMRect has no own enumerable props, so it serializes to {} — copy the fields
    const rect = (el) => { const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    const el = document.getElementById('browse-channels');
    return { b: rect(el), p: rect(document.getElementById('new-channel')), head: rect(el.closest('h3')), title: el.title };
  });
  assert(geom.b.top >= geom.head.top - 1 && geom.b.bottom <= geom.head.bottom + 1, 'browse button is not on the CHANNELS header row');
  assert(geom.b.right <= geom.p.left + 1, 'browse button is not immediately left of +');
  assert(Math.abs(geom.b.height - geom.p.height) <= 6, 'browse/+ heights differ: ' + geom.b.height + ' vs ' + geom.p.height);
  assert(geom.b.width >= geom.p.width * 0.7, 'browse glyph is optically lighter than +: ' + geom.b.width + ' vs ' + geom.p.width);
  assert(/browse/i.test(geom.title), 'browse button has no hover label, title=' + geom.title);

  // the list is the whole public map
  await page.click('#browse-channels');
  await page.waitForFunction(() => document.querySelectorAll('#browse-list .browse-row').length >= 3, { timeout: 8000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll('#browse-list .browse-row')].map((r) => ({
    name: r.querySelector('.browse-name').textContent,
    member: r.classList.contains('member'),
    note: r.querySelector('.browse-member-note')?.textContent || '',
    join: !!r.querySelector('.browse-join'),
    nameColor: getComputedStyle(r.querySelector('.browse-name')).color,
  })));
  const by = (n) => rows.find((r) => r.name === '#' + n);
  assert(by('general') && by('general').member, '#general (a member channel) missing or unmarked');
  assert(by('mine') && by('mine').member, '#mine (a member channel) missing or unmarked');
  assert(by('open-one') && !by('open-one').member, '#open-one should be joinable');
  assert(!by('hidden'), 'private #hidden leaked into browse');
  assert(by('mine').note === 'already a member', 'member row note is ' + JSON.stringify(by('mine').note));
  assert(!by('mine').join, 'member row still offers Join');
  assert(by('open-one').join, 'joinable row lost its Join button');
  assert(by('mine').nameColor !== by('open-one').nameColor, 'member rows are not grayed differently from joinable ones');
  await page.screenshot({ path: (process.env.OUT || '.') + '/browse-list.png' });

  // joining flips the row to a member row in place
  await page.evaluate(() => [...document.querySelectorAll('#browse-list .browse-row')]
    .find((r) => r.querySelector('.browse-name').textContent === '#open-one').querySelector('.browse-join').click());
  await page.waitForFunction(() => {
    const r = [...document.querySelectorAll('#browse-list .browse-row')]
      .find((x) => x.querySelector('.browse-name').textContent === '#open-one');
    return r && r.classList.contains('member') && !r.querySelector('.browse-join');
  }, { timeout: 8000 });

  await browser.close();
  console.log('BROWSE_CHECK_OK');
})().catch((e) => { console.error('BROWSE_CHECK_FAIL:', e.message); process.exit(1); });
