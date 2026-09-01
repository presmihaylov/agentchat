// E2E: mention-only channel counters. A channel's sidebar badge shows a NUMBER
// only for unread @mentions (direct or @channel/@here/@everyone). A plain unread
// with no mention just glows/bolds the channel name, no number.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/mentionbadge-check.js
// Needs a server on $SERVER (default :8095) backed by a live Postgres.
const puppeteer = require('puppeteer-core');
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

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'mention badge check' } });
  const roomCode = created.invite_code;
  const slug = created.room.slug;

  const sender = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'sender', description: 'agent', avatar: '🤖' } });
  // viewer must exist BEFORE the @viewer message so the mention resolves
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'viewer', description: 'human', avatar: '🧑', is_human: true } });

  const mkChan = (name) => api('/api/v1/channels', { method: 'POST', token: sender.token, body: { name } });
  await mkChan('glowonly');
  await mkChan('mentioned');
  await mkChan('broadcast');
  // membership: only members see a channel's counters, so viewer joins first
  for (const ch of ['glowonly', 'mentioned', 'broadcast'])
    await api('/api/v1/channels/' + ch + '/join', { method: 'POST', token: viewer.token });
  const post = (chan, body) => api('/api/v1/channels/' + chan + '/messages', { method: 'POST', token: sender.token, body: { body } });

  // glowonly: two plain messages -> unread, no mention -> glow, NO number
  await post('glowonly', 'hello there');
  await post('glowonly', 'still nothing for you');
  // mentioned: one plain + one direct @viewer -> glow + badge "1"
  await post('mentioned', 'unrelated note');
  await post('mentioned', 'hey @viewer take a look');
  // broadcast: one @channel -> glow + badge "1"
  await post('broadcast', '@channel all-hands ping');

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  // log in as the pre-created viewer by seeding its token, bypassing the join form
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, tok) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: tok })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('#channel-list li', { timeout: 8000 });

  // read each channel row: is it glowing (unread class), and what does its badge say?
  const rows = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#channel-list li').forEach((li) => {
      // name lives in the li's first text node; the badge is a separate <span>
      const name = (li.childNodes[0].textContent || '').replace(/^#\s*/, '').trim().split(' ')[0];
      const badge = li.querySelector('.unread-badge');
      out[name] = { glow: li.classList.contains('unread'), badge: badge ? badge.textContent : null };
    });
    return out;
  });

  const want = {
    glowonly: { glow: true, badge: null },   // unread, no mention -> glow only
    mentioned: { glow: true, badge: '1' },   // direct @viewer -> number
    broadcast: { glow: true, badge: '1' },   // @channel -> number
  };
  for (const [name, w] of Object.entries(want)) {
    const got = rows[name];
    if (!got) { fail('channel ' + name + ' row missing: ' + JSON.stringify(rows)); continue; }
    if (got.glow !== w.glow) fail(name + ' glow=' + got.glow + ', want ' + w.glow);
    if (got.badge !== w.badge) fail(name + ' badge=' + JSON.stringify(got.badge) + ', want ' + JSON.stringify(w.badge));
  }
  // the active channel (general) must never badge itself
  if (rows.general && rows.general.badge !== null) fail('active general channel shows a badge');

  await browser.close();
  if (!process.exitCode) console.log('MENTIONBADGE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
