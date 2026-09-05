// E2E for FR #2 private channels in the web UI. alice creates a private
// channel through the New-channel flow (name prompt + "make private?" confirm),
// sees the 🔒 lock sigil in the sidebar, and adds bob via the row's "Add people"
// menu. bob then sees the private channel in his sidebar. The private channel
// never shows in bob's Browse.
// Run: NODE_PATH=scripts/node_modules SERVER=http://localhost:8095 node scripts/private-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
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

const openAs = async (browser, slug, joined) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 850 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await openAsHuman(page, SERVER, slug, joined);
  await page.waitForSelector('#channel-list li', { timeout: 6000 });
  return page;
};

const hasChannel = (page, name) => page.evaluate((n) =>
  [...document.querySelectorAll('#channel-list li')].some((li) => li.textContent.includes(n)), name);

(async () => {
  const created = await newRoom(SERVER, 'private check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'bob', is_human: true } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // --- alice creates a private channel through the UI dialogs ---
  const ap = await openAs(browser, slug, alice);
  ap.on('dialog', async (d) => {
    const m = d.message();
    if (/Channel name/.test(m)) return d.accept('war-room');
    if (/private/i.test(m)) return d.accept();      // confirm -> private = true
    if (/Add who/.test(m)) return d.accept('bob');
    return d.accept();
  });
  await ap.click('#new-channel');
  // the 🔒 lock sigil marks the private channel in the sidebar.
  await ap.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li')].some((li) => li.textContent.includes('🔒') && li.textContent.includes('war-room')),
    { timeout: 5000 });
  await ap.screenshot({ path: SHOT + '/private-created.png' });

  // --- alice adds bob via the "Add people" row menu ---
  await ap.evaluate(() => {
    const li = [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.includes('war-room'));
    li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
  });
  const clickedAdd = await ap.evaluate(() => {
    const item = [...document.querySelectorAll('div,li,button,span')].find((e) => e.textContent.trim() === 'Add people' && e.children.length === 0);
    if (!item) return false;
    item.click();
    return true;
  });
  if (!clickedAdd) throw new Error('no "Add people" menu item on the private channel');
  // give the add request time to land
  await ap.waitForFunction(async () => true, { timeout: 500 }).catch(() => {});

  // --- bob now sees the private channel; Browse never lists it ---
  const bp = await openAs(browser, slug, bob);
  await bp.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li')].some((li) => li.textContent.includes('war-room')),
    { timeout: 6000 });
  if (!(await hasChannel(bp, '🔒'))) throw new Error("bob's sidebar missing the lock sigil");
  await bp.screenshot({ path: SHOT + '/private-bob.png' });

  await bp.click('#browse-channels');
  await bp.waitForSelector('#browse-modal:not(.hidden)', { timeout: 4000 });
  const leaked = await bp.evaluate(() =>
    [...document.querySelectorAll('.browse-name')].some((e) => /war-room/.test(e.textContent)));
  if (leaked) throw new Error('Browse leaked a private channel');

  await browser.close();
  console.log('PRIVATE_CHECK_OK');
})().catch((e) => { console.error('PRIVATE_CHECK_FAIL:', e.message); process.exit(1); });
