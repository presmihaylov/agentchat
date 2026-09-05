// E2E for quiet threads: a thread nobody wrote in for the configured period
// simply leaves the sidebar (there is no Archived section any more), a new
// reply brings it back, a mention brings it back, a manual hide (✕ or the
// menu) drops it until the next message, the open thread never disappears,
// the setting persists on the server, and Off keeps everything pinned.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/archive-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman, openSettings, backToRoom } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';

async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status >= 400) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const created = await newRoom(SERVER, 'archive check');
  const slug = created.room.slug;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'bob', description: 'bot' } });
  const say = (body, extra = {}) => api('/api/v1/channels/general/messages', {
    method: 'POST', token: bob.token, body: Object.assign({ body }, extra),
  });
  // a second channel for alice to look at, so a mention in #general notifies
  await api('/api/v1/channels', { method: 'POST', token: alice.token, body: { name: 'plaza' } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: alice.token, body: { body: 'alice topic' } });
  await say('first reply', { thread_root_id: root.id });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
    await openAsHuman(page, SERVER, slug, alice);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  const leaves = () => page.evaluate(() => [...document.querySelectorAll('#channel-list li.thread-leaf')]
    .map((li) => li.querySelector('.t-snippet').textContent));
  const waitLeaves = async (pred, label) => {
    try {
      await page.waitForFunction((src) => (new Function('return ' + src))()(
        [...document.querySelectorAll('#channel-list li.thread-leaf')].map((li) => li.querySelector('.t-snippet').textContent),
      ), { timeout: 15000 }, pred.toString());
    } catch (e) { throw new Error(label + ': ' + JSON.stringify(await leaves())); }
  };
  const noArchivedSection = () => page.evaluate(() => ![...document.querySelectorAll('#channel-list li')].some((li) => /^Archived/.test(li.textContent.trim())));

  // 1. live thread: pinned under #general
  await waitLeaves((l) => l.includes('alice topic'), 'live thread');

  // 2. set the period to 15 minutes on /settings; the server persists it
  await openSettings(page, SERVER);
  const initial = await page.$eval('#archive-after', (el) => el.value);
  assert(initial === '3600', 'default select must be 1h, got ' + initial);
  await page.select('#archive-after', '900');
  await sleep(500);
  await backToRoom(page);
  let prefs = await api('/api/v1/me/notifications', { token: alice.token });
  assert(prefs.archive_after_secs === 900, 'server pref: ' + JSON.stringify(prefs));

  // 3. inactivity: fake the clock 16 minutes ahead; on the next tick the thread
  //    is simply gone, and nothing called "Archived" appears anywhere
  await page.evaluate(() => {
    const real = Date.now;
    window.__skew = 16 * 60 * 1000;
    Date.now = () => real() + window.__skew;
  });
  await waitLeaves((l) => !l.includes('alice topic'), 'quiet thread must leave the sidebar');
  assert(await noArchivedSection(), 'an Archived section is still rendered');
  await page.screenshot({ path: (process.env.OUT || '.') + '/archive-section.png' });

  // 4. revive on a plain reply from someone else: back in the sidebar. The
  //    clock returns to real time first, or the fresh reply is already "old".
  await page.evaluate(() => { window.__skew = 0; });
  await say('a plain reply', { thread_root_id: root.id });
  await waitLeaves((l) => l.includes('alice topic'), 'reply must revive');

  // 5. the open thread stays in the sidebar even when it goes quiet
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li.thread-leaf')].find((li) => /alice topic/.test(li.textContent)).click());
  await page.waitForSelector('#thread-panel:not(.hidden)', { timeout: 5000 });
  await page.evaluate(() => { window.__skew = 16 * 60 * 1000; });
  await sleep(11000); // one render tick
  assert((await leaves()).includes('alice topic'), 'open thread vanished while open');
  await page.click('#thread-close');
  await waitLeaves((l) => !l.includes('alice topic'), 'closed quiet thread must leave');
  await page.evaluate(() => { window.__skew = 0; });
  await say('another reply', { thread_root_id: root.id });
  await waitLeaves((l) => l.includes('alice topic'), 'reply must revive again');

  // 6. manual hide via the context menu: gone from the sidebar and from the
  //    server's default listing; nothing in the menu offers an unarchive
  const leafBox = async () => (await (await page.evaluateHandle(() => [...document.querySelectorAll('#channel-list li.thread-leaf')]
    .find((li) => /alice topic/.test(li.textContent)))).boundingBox());
  let box = await leafBox();
  await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.ctx-item', { timeout: 5000 });
  const items = await page.$$eval('.ctx-item', (bs) => bs.map((b) => b.textContent));
  assert(items.includes('Hide thread') && !items.some((t) => /archive/i.test(t)), 'leaf menu: ' + JSON.stringify(items));
  await page.evaluate(() => [...document.querySelectorAll('.ctx-item')].find((b) => b.textContent === 'Hide thread').click());
  await waitLeaves((l) => !l.includes('alice topic'), 'manual hide');
  assert(await noArchivedSection(), 'manual hide grew an Archived section');
  let onServer = (await api('/api/v1/threads', { token: alice.token })).threads.find((t) => t.root_id === root.id);
  assert(!onServer, 'hidden thread still in the default listing');
  await say('someone wrote again', { thread_root_id: root.id });
  await waitLeaves((l) => l.includes('alice topic'), 'a reply must bring a hidden thread back');

  // 7. hide with the hover ✕; the @mention revives it and notifies as usual
  await page.evaluate(() => { window.__notes = []; document.addEventListener('agentchat:notify', (ev) => window.__notes.push(ev.detail)); });
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li.thread-leaf')]
    .find((li) => /alice topic/.test(li.textContent)).querySelector('.t-archive').click());
  await waitLeaves((l) => !l.includes('alice topic'), 'hover hide must reach the sidebar');
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li')].find((li) => /plaza/.test(li.textContent)).click());
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('plaza'), { timeout: 8000 });
  await say('hey @alice look', { thread_root_id: root.id });
  await waitLeaves((l) => l.includes('alice topic'), 'mention must revive a hidden thread');
  await sleep(500);
  const notes = await page.evaluate(() => window.__notes.splice(0));
  assert(notes.some((n) => n.why === 'mention'), 'mention must notify: ' + JSON.stringify(notes));

  // 8. Off keeps a stale thread pinned; the setting survives a reload
  await openSettings(page, SERVER);
  await page.select('#archive-after', '0');
  await sleep(500);
  await backToRoom(page);
  // the settings trip was a navigation: skew the fresh page's clock again
  await page.evaluate(() => {
    const real = Date.now;
    window.__skew = 30 * 24 * 3600 * 1000;
    Date.now = () => real() + window.__skew;
  });
  await waitLeaves((l) => l.includes('alice topic'), 'Off must keep it pinned');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await openSettings(page, SERVER);
  const persisted = await page.$eval('#archive-after', (el) => el.value);
  assert(persisted === '0', 'Off did not persist: ' + persisted);
  prefs = await api('/api/v1/me/notifications', { token: alice.token });
  assert(prefs.archive_after_secs === 0, 'server pref after Off: ' + JSON.stringify(prefs));

  await browser.close();
  console.log('ARCHIVE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
