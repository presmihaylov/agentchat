// E2E for FR #3 personal sidebar sections (channel groups) in the web UI.
// bob posts an @alice mention in #proj so it carries an unread mention. alice
// then: moves #proj into a new "Work" section via the row context menu, collapses
// the section, and confirms the collapsed header rolls up the mention (glow +
// numeric badge). A reload proves the collapsed state persisted server-side.
// Sections are personal, so bob never sees alice's "Work".
// Run: NODE_PATH=scripts/node_modules SERVER=http://localhost:8095 node scripts/groups-check.js
const puppeteer = require('puppeteer-core');
const { newRoom } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const SHOT = '/private/tmp/claude-501/-Users-pmihaylov-prg-repos/78cd3fcc-ad11-42d3-ba05-8de92cc37e7a/scratchpad';

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

const openAs = async (browser, slug, token) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 850 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#channel-list li', { timeout: 6000 });
  return page;
};

const rightClickChannel = (page, name) => page.evaluate((n) => {
  const li = [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.includes(n) && !l.classList.contains('section-header'));
  if (!li) throw new Error('no channel row for ' + n);
  li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
}, name);

const clickMenuItem = (page, label) => page.evaluate((l) => {
  const item = [...document.querySelectorAll('div,li,button,span')].find((e) => e.textContent.trim() === l && e.children.length === 0);
  if (!item) throw new Error('no menu item: ' + l);
  item.click();
}, label);

const sectionHeader = (page, name) => page.evaluate((n) =>
  [...document.querySelectorAll('#channel-list li.section-header')].some((h) => h.textContent.includes(n)), name);

(async () => {
  const created = await newRoom(SERVER, 'groups check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'bob', is_human: true } });

  // alice owns #proj; bob joins it and drops an @alice mention so it is unread.
  const proj = await api('/api/v1/channels', { method: 'POST', body: { name: 'proj' }, token: alice.token });
  await api('/api/v1/channels/' + proj.id + '/join', { method: 'POST', token: bob.token });
  await api('/api/v1/channels/' + proj.id + '/messages', { method: 'POST', body: { body: 'hey @alice look here' }, token: bob.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const ap = await openAs(browser, slug, alice.token);
  ap.on('dialog', async (d) => {
    if (/section name/i.test(d.message())) return d.accept('Work');
    return d.accept();
  });

  // #proj arrives with an unread @mention badge before it is grouped.
  await ap.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li')].some((li) => li.textContent.includes('proj') && li.querySelector('.unread-badge')),
    { timeout: 6000 });

  // --- move #proj into a brand-new "Work" section ---
  await rightClickChannel(ap, 'proj');
  await clickMenuItem(ap, 'Move to section…');
  await clickMenuItem(ap, '＋ New section…');           // opens the "section name" prompt
  await ap.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li.section-header')].some((h) => h.textContent.includes('Work')),
    { timeout: 5000 });
  await ap.screenshot({ path: SHOT + '/groups-created.png' });

  // --- collapse the section; the header must roll up proj's unread mention ---
  await ap.evaluate(() => {
    const h = [...document.querySelectorAll('#channel-list li.section-header')].find((e) => e.textContent.includes('Work'));
    h.click();
  });
  await ap.waitForFunction(() => {
    const h = [...document.querySelectorAll('#channel-list li.section-header')].find((e) => e.textContent.includes('Work'));
    return h && h.classList.contains('collapsed') && h.classList.contains('unread') && h.querySelector('.unread-badge');
  }, { timeout: 5000 });
  // proj is hidden while the section is collapsed
  const projHidden = await ap.evaluate(() =>
    ![...document.querySelectorAll('#channel-list li:not(.section-header)')].some((li) => li.textContent.includes('proj')));
  if (!projHidden) throw new Error('proj still visible under a collapsed section');
  await ap.screenshot({ path: SHOT + '/groups-collapsed.png' });

  // --- collapse persists across a reload (server-side per-participant state) ---
  await ap.reload({ waitUntil: 'networkidle2' });
  await ap.waitForFunction(() => {
    const h = [...document.querySelectorAll('#channel-list li.section-header')].find((e) => e.textContent.includes('Work'));
    return h && h.classList.contains('collapsed');
  }, { timeout: 6000 });

  // --- sections are personal: bob has no "Work" ---
  const bp = await openAs(browser, slug, bob.token);
  await bp.waitForSelector('#channel-list li', { timeout: 6000 });
  if (await sectionHeader(bp, 'Work')) throw new Error('bob sees alice private section');

  await browser.close();
  console.log('GROUPS_CHECK_OK');
})().catch((e) => { console.error('GROUPS_CHECK_FAIL:', e.message); process.exit(1); });
