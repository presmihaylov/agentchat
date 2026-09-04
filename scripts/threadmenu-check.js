// E2E for the sidebar thread-leaf context menu (FR-D). Right-click a thread leaf
// must open a themed menu (NOT instantly toggle mute); "Hide thread" removes
// the leaf from the tree; the menu dismisses on Esc.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/threadmenu-check.js
const puppeteer = require('puppeteer-core');
const { newRoom } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';

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

(async () => {
  const created = await newRoom(SERVER, 'threadmenu check');
  const code = created.invite_code, slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'viewer', avatar: '🧑', is_human: true } });
  const sender = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'sender', avatar: '🤖' } });

  // viewer starts a thread, sender replies -> viewer is involved, sees a leaf
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: viewer.token, body: { body: 'topic for the menu' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: sender.token, body: { body: 'a reply', thread_root_id: root.id } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  // seed the legacy token on a neutral page first: a room load without it
  // bounces to /login and a reload there never comes back
  await page.goto(SERVER + '/login', { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.thread-leaf', { timeout: 6000 });

  // right-click the leaf: menu opens, mute state unchanged (still the 🧵 icon)
  const leaf = await page.$('.thread-leaf');
  const box = await leaf.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 3000 }).catch(() => fail('context menu did not open on right-click'));

  const items = await page.$$eval('.context-menu .ctx-item', (els) => els.map((e) => e.textContent));
  if (!items.some((t) => /mute/i.test(t))) fail('no Mute item in menu: ' + JSON.stringify(items));
  if (!items.some((t) => /hide/i.test(t))) fail('no Hide item in menu: ' + JSON.stringify(items));

  const iconAfterOpen = await page.$eval('.thread-leaf .t-icon', (e) => e.textContent);
  if (iconAfterOpen === '🔇') fail('right-click instantly muted (icon changed) instead of opening a menu');

  // Esc dismisses the menu
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 150));
  if (await page.$('.context-menu')) fail('menu did not dismiss on Esc');

  // reopen and click Hide -> leaf disappears from the tree
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 3000 });
  const resolveIdx = (await page.$$eval('.context-menu .ctx-item', (els) => els.map((e) => e.textContent))).findIndex((t) => /hide/i.test(t));
  const btns = await page.$$('.context-menu .ctx-item');
  await btns[resolveIdx].click();
  await page.waitForFunction(() => !document.querySelector('.thread-leaf'), { timeout: 4000 }).catch(() => fail('leaf still present after Hide'));

  await browser.close();
  if (!process.exitCode) console.log('THREADMENU_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
