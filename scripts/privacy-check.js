// E2E: public -> private conversion from the channel context menu. The lock
// icon lands in the sidebar and header immediately; the menu offer follows the
// admin/creator gate and disappears once the channel is private.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/privacy-check.js
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

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'privacy check' } });
  const slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', avatar: '🧑', is_human: true } });
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'privbot', description: 't' } });
  await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'pub', topic: '' } });
  await api('/api/v1/channels/pub/join', { method: 'POST', token: viewer.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  const rightClickPub = () => page.evaluate(() => {
    const li = [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.includes('pub'));
    li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }));
  });
  const menuLabels = () => page.evaluate(() =>
    [...document.querySelectorAll('.context-menu .ctx-item')].map((b) => b.textContent));

  // viewer is the admin (first joiner): the menu offers Make private on a
  // public channel someone else created
  await page.evaluate(() => { window.confirm = () => true; });
  await page.evaluate(() => {
    [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.includes('pub')).click();
  });
  await page.waitForFunction(() => document.querySelector('#channel-title')?.textContent.includes('pub'), { timeout: 8000 });
  await rightClickPub();
  let labels = await menuLabels();
  assert(labels.includes('Make private'), 'menu missing Make private: ' + labels.join());
  await page.evaluate(() => {
    [...document.querySelectorAll('.context-menu .ctx-item')].find((b) => b.textContent === 'Make private').click();
  });

  // lock icon lands in the sidebar and the open header immediately
  await page.waitForFunction(() => {
    const li = [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.includes('pub'));
    return li && li.textContent.includes('🔒');
  }, { timeout: 8000 }).catch(() => { throw new Error('sidebar lock icon did not appear'); });
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('🔒'), { timeout: 8000 })
    .catch(() => { throw new Error('header lock icon did not appear'); });

  // once private: no Make private offer, Add people appears instead
  await rightClickPub();
  labels = await menuLabels();
  assert(!labels.includes('Make private'), 'private channel still offers Make private');
  assert(labels.includes('Add people'), 'private channel misses Add people: ' + labels.join());

  // server agrees end to end: browse hides it, self-join is blocked
  const stranger = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'stranger', description: 't' } });
  const browse = await api('/api/v1/channels/browse', { token: stranger.token });
  assert(!(browse.channels || []).some((c) => c.name === 'pub'), 'private channel still browsable');
  const joined = await fetch(SERVER + '/api/v1/channels/pub/join', {
    method: 'POST', headers: { Authorization: 'Bearer ' + stranger.token },
  });
  assert(joined.status === 403, 'self-join after convert = ' + joined.status + ', want 403');

  await browser.close();
  console.log('PRIVACY_CHECK_OK');
})().catch((e) => { console.error('PRIVACY_CHECK_FAIL:', e.message); process.exit(1); });
