// E2E for sidebar auto-archive: a quiet thread leaves the sidebar after the
// configured period and lands in a collapsed "Archived" section, a new reply
// revives it, a mention revives it, manual archive/unarchive both work, the
// setting persists on the server, and Off keeps everything pinned.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/archive-check.js
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
  if (resp.status >= 400) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'archive check' } });
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
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, alice.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  const leaves = () => page.evaluate(() => [...document.querySelectorAll('#channel-list li.thread-leaf')]
    .map((li) => (li.classList.contains('archived') ? 'A:' : 'L:') + li.querySelector('.t-snippet').textContent));
  const archivedHeader = () => page.evaluate(() => {
    const h = document.querySelector('#channel-list li.archived-header');
    return h ? h.textContent : null;
  });
  const waitLeaves = async (pred, label) => {
    try {
      await page.waitForFunction((src) => (new Function('return ' + src))()(
        [...document.querySelectorAll('#channel-list li.thread-leaf')]
          .map((li) => (li.classList.contains('archived') ? 'A:' : 'L:') + li.querySelector('.t-snippet').textContent),
        !!document.querySelector('#channel-list li.archived-header'),
      ), { timeout: 15000 }, pred.toString());
    } catch (e) { throw new Error(label + ': ' + JSON.stringify(await leaves()) + ' header=' + await archivedHeader()); }
  };

  // 1. live thread: pinned under #general, no Archived section
  await waitLeaves((l, h) => l.includes('L:alice topic') && !h, 'live thread');

  // 2. set the period to 15 minutes via the profile card; the server persists it
  await page.click('#me-footer');
  await page.waitForSelector('#notify-settings:not(.hidden)', { timeout: 5000 });
  const initial = await page.$eval('#archive-after', (el) => el.value);
  assert(initial === '3600', 'default select must be 1h, got ' + initial);
  await page.select('#archive-after', '900');
  await sleep(500);
  await page.click('#profile-close');
  let prefs = await api('/api/v1/me/notifications', { token: alice.token });
  assert(prefs.archive_after_secs === 900, 'server pref: ' + JSON.stringify(prefs));

  // 3. inactivity: fake the clock 16 minutes ahead; the timer moves the thread
  //    into a collapsed Archived section on its next tick
  await page.evaluate(() => {
    const real = Date.now;
    window.__skew = 16 * 60 * 1000;
    Date.now = () => real() + window.__skew;
  });
  await waitLeaves((l, h) => !l.includes('L:alice topic') && h, 'quiet thread must archive');
  assert(/Archived/.test(await archivedHeader()), 'header text: ' + await archivedHeader());
  await page.evaluate(() => document.querySelector('#channel-list li.archived-header').click());
  await waitLeaves((l) => l.includes('A:alice topic'), 'expanded Archived must list it');
  await page.screenshot({ path: (process.env.OUT || '.') + '/archive-section.png' });

  // 4. revive on a plain reply from someone else: back in the sidebar. The
  //    clock returns to real time first, or the fresh reply is already "old".
  await page.evaluate(() => { window.__skew = 0; });
  await say('a plain reply', { thread_root_id: root.id });
  await waitLeaves((l) => l.includes('L:alice topic') && !l.includes('A:alice topic'), 'reply must revive');

  // 5. manual archive via the context menu, then unarchive from the Archived section
  const leafBox = async (sel) => (await (await page.evaluateHandle((s) => [...document.querySelectorAll('#channel-list li.thread-leaf' + s)]
    .find((li) => /alice topic/.test(li.textContent)), sel)).boundingBox());
  let box = await leafBox(':not(.archived)');
  await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.ctx-item', { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.ctx-item')].find((b) => b.textContent === 'Archive thread').click());
  await waitLeaves((l, h) => !l.includes('L:alice topic') && h, 'manual archive');
  let onServer = (await api('/api/v1/threads?include_archived=1', { token: alice.token })).threads.find((t) => t.root_id === root.id);
  assert(onServer.resolved === true, 'manual archive did not reach the server');
  // the section stays open from step 3, so the archived leaf is on screen
  await waitLeaves((l) => l.includes('A:alice topic'), 'archived leaf visible');
  await page.evaluate(() => { window.__skew = 16 * 60 * 1000; });
  box = await leafBox('.archived');
  await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.ctx-item', { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.ctx-item')].find((b) => b.textContent === 'Unarchive thread').click());
  // the clock still says the thread is old, so the unarchive stamp must win
  await waitLeaves((l, h) => l.includes('L:alice topic') && !h, 'manual unarchive must override the clock');
  onServer = (await api('/api/v1/threads?include_archived=1', { token: alice.token })).threads.find((t) => t.root_id === root.id);
  assert(onServer.resolved === false && onServer.unarchived_at, 'unarchive stamp missing: ' + JSON.stringify(onServer));

  // 6. archive with the hover ✕; the @mention revives it and notifies as usual
  await page.evaluate(() => { window.__notes = []; document.addEventListener('agentchat:notify', (ev) => window.__notes.push(ev.detail)); });
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li.thread-leaf:not(.archived)')]
    .find((li) => /alice topic/.test(li.textContent)).querySelector('.t-archive').click());
  await waitLeaves((l) => !l.includes('L:alice topic'), 'hover archive must reach the sidebar');
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li')].find((li) => /plaza/.test(li.textContent)).click());
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('plaza'), { timeout: 8000 });
  await page.evaluate(() => { window.__skew = 0; });
  await say('hey @alice look', { thread_root_id: root.id });
  await waitLeaves((l) => l.includes('L:alice topic'), 'mention must revive a manual archive');
  await sleep(500);
  const notes = await page.evaluate(() => window.__notes.splice(0));
  assert(notes.some((n) => n.why === 'mention'), 'mention must notify: ' + JSON.stringify(notes));

  // 7. Off keeps a stale thread pinned; the setting survives a reload
  await page.evaluate(() => { window.__skew = 30 * 24 * 3600 * 1000; });
  await page.click('#me-footer');
  await page.waitForSelector('#notify-settings:not(.hidden)', { timeout: 5000 });
  await page.select('#archive-after', '0');
  await sleep(500);
  await page.click('#profile-close');
  await waitLeaves((l, h) => l.includes('L:alice topic') && !h, 'Off must keep it pinned');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.click('#me-footer');
  await page.waitForSelector('#notify-settings:not(.hidden)', { timeout: 5000 });
  const persisted = await page.$eval('#archive-after', (el) => el.value);
  assert(persisted === '0', 'Off did not persist: ' + persisted);
  prefs = await api('/api/v1/me/notifications', { token: alice.token });
  assert(prefs.archive_after_secs === 0, 'server pref after Off: ' + JSON.stringify(prefs));

  await browser.close();
  console.log('ARCHIVE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
