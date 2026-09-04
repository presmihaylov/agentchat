// E2E for FR #1 channel membership (browse + join + leave) in the web UI.
// bob does not see #secret in the sidebar; opens Browse, sees it with a member
// count, joins it (now in sidebar + selectable), then leaves it via the row
// context menu (back out of the sidebar). #general has no Leave option.
// Run: NODE_PATH=<puppeteer dir> SERVER=http://localhost:8095 node scripts/membership-check.js
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

const chanNames = (page) => page.$$eval('#channel-list li', (lis) =>
  lis.map((li) => li.textContent.replace(/^#\s*/, '').split(' ')[0]));

(async () => {
  const created = await newRoom(SERVER, 'membership check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'bob', is_human: true } });
  // alice creates #secret (auto-joins) and posts; bob is NOT a member.
  const secret = await api('/api/v1/channels', { method: 'POST', body: { name: 'secret', topic: 'ship logs' }, token: alice.token });
  await api('/api/v1/channels/secret/messages', { method: 'POST', body: { body: 'classified' }, token: alice.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 850 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, bob.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#channel-list li', { timeout: 6000 });

  // 1. bob's sidebar shows #general but NOT #secret.
  let names = await chanNames(page);
  if (!names.includes('general')) throw new Error('sidebar missing #general: ' + JSON.stringify(names));
  if (names.includes('secret')) throw new Error('sidebar leaked #secret before join: ' + JSON.stringify(names));

  // 2. open Browse, #secret is listed with member count 1.
  await page.click('#browse-channels');
  await page.waitForSelector('#browse-modal:not(.hidden) .browse-row', { timeout: 4000 });
  const browseRows = await page.$$eval('.browse-row', (rows) => rows.map((r) => ({
    name: r.querySelector('.browse-name').textContent,
    count: r.querySelector('.browse-count').textContent,
  })));
  const secretRow = browseRows.find((r) => r.name === '#secret');
  if (!secretRow) throw new Error('browse missing #secret: ' + JSON.stringify(browseRows));
  if (!/1 member/.test(secretRow.count)) throw new Error('bad member count: ' + secretRow.count);

  // 3. click Join on #secret's row.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.browse-row')].find((r) => r.querySelector('.browse-name').textContent === '#secret');
    row.querySelector('.browse-join').click();
  });
  // after join, #secret appears in the sidebar.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li')].some((li) => li.textContent.replace(/^#\s*/, '').startsWith('secret')),
    { timeout: 4000 });
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-pmihaylov-prg-repos/78cd3fcc-ad11-42d3-ba05-8de92cc37e7a/scratchpad/membership-joined.png' });

  // bob can now read the earlier message.
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.replace(/^#\s*/, '').startsWith('secret'));
    li.click();
  });
  await page.waitForFunction(() => /classified/.test(document.querySelector('#messages')?.textContent || ''), { timeout: 4000 });

  // 4. leave #secret via the row context menu.
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.replace(/^#\s*/, '').startsWith('secret'));
    li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
  });
  await page.waitForSelector('.context-menu, #context-menu, .ctx-menu', { timeout: 2000 }).catch(() => {});
  // click the "Leave channel" item wherever the menu rendered.
  const clickedLeave = await page.evaluate(() => {
    const item = [...document.querySelectorAll('div,li,button,span')].find((e) => e.textContent.trim() === 'Leave channel' && e.children.length === 0);
    if (!item) return false;
    item.click();
    return true;
  });
  if (!clickedLeave) throw new Error('no "Leave channel" menu item found');
  await page.waitForFunction(() =>
    ![...document.querySelectorAll('#channel-list li')].some((li) => li.textContent.replace(/^#\s*/, '').startsWith('secret')),
    { timeout: 4000 });

  // 5. #general offers no Leave option (pinned).
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#channel-list li')].find((l) => l.textContent.replace(/^#\s*/, '').startsWith('general'));
    li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 120 }));
  });
  const generalHasLeave = await page.evaluate(() =>
    [...document.querySelectorAll('div,li,button,span')].some((e) => e.textContent.trim() === 'Leave channel' && e.children.length === 0));
  if (generalHasLeave) throw new Error('#general wrongly offered a Leave option');

  await browser.close();
  console.log('MEMBERSHIP_CHECK_OK');
})().catch((e) => { console.error('MEMBERSHIP_CHECK_FAIL:', e.message); process.exit(1); });
