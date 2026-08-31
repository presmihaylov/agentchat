// E2E: hover-to-archive X on sidebar thread leaves (Maya FR seq 344). Each thread
// leaf carries an X that is hidden until you hover the leaf (shadcn-style fade),
// and clicking it archives (resolves) the thread so it leaves the sidebar. A new
// reply resurfaces the thread, matching the resolve semantics.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/archive-check.js
const puppeteer = require('puppeteer-core');
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

const leafCount = (page) => page.$$eval('#channel-list li.thread-leaf', (l) => l.length);
// opacity of the X inside the leaf whose snippet starts with `pre`
const xOpacity = (page, pre) => page.evaluate((p) => {
  const li = [...document.querySelectorAll('#channel-list li.thread-leaf')]
    .find((x) => (x.querySelector('.t-snippet') || {}).textContent.startsWith(p));
  if (!li) return null;
  return Number(getComputedStyle(li.querySelector('.t-archive')).opacity);
}, pre);

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'archive check' } });
  const slug = created.room.slug, code = created.invite_code;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'threadbot', avatar: '🤖' } });
  const rootA = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'alpha root' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'a reply', thread_root_id: rootA.id } });
  const rootB = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'bravo root' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'b reply', thread_root_id: rootB.id } });
  const human = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'humantester', avatar: '🧑', is_human: true } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: human.token, body: { body: 'in alpha', thread_root_id: rootA.id } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: human.token, body: { body: 'in bravo', thread_root_id: rootB.id } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, human.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#channel-list li.thread-leaf .t-archive', { timeout: 6000 });

  if (await leafCount(page) !== 2) throw new Error('expected two thread leaves at start');

  // 1) HIDDEN BY DEFAULT: X is transparent until you hover its leaf
  if (await xOpacity(page, 'alpha') !== 0) throw new Error('archive X should be hidden before hover');

  // 2) HOVER REVEALS: hovering alpha's leaf fades its X in (not bravo's)
  await page.hover('#channel-list li.thread-leaf'); // first leaf in DOM order
  await page.waitForFunction(() => {
    const li = document.querySelector('#channel-list li.thread-leaf');
    return Number(getComputedStyle(li.querySelector('.t-archive')).opacity) > 0.9;
  }, { timeout: 2000 });

  // 3) CLICK ARCHIVES: the thread resolves and leaves the sidebar (2 -> 1)
  const firstSnippet = await page.$eval('#channel-list li.thread-leaf .t-snippet', (e) => e.textContent);
  await page.click('#channel-list li.thread-leaf .t-archive');
  await page.waitForFunction(() => document.querySelectorAll('#channel-list li.thread-leaf').length === 1, { timeout: 4000 });
  const remaining = await page.$eval('#channel-list li.thread-leaf .t-snippet', (e) => e.textContent);
  if (remaining === firstSnippet) throw new Error('the archived leaf is still shown: ' + remaining);

  // 4) RESURFACE ON MENTION: an @mention reply un-resolves the thread for the
  // mentioned viewer, so the archived leaf returns (1 -> 2). A plain reply does
  // NOT resurface it — archive stays archived unless you are pinged.
  const archivedRoot = firstSnippet.startsWith('alpha') ? rootA.id : rootB.id;
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: '@humantester poke', thread_root_id: archivedRoot } });
  await page.waitForFunction(() => document.querySelectorAll('#channel-list li.thread-leaf').length === 2, { timeout: 6000 });

  await browser.close();
  if (!process.exitCode) console.log('ARCHIVE_CHECK_OK');
})().catch((e) => { console.error('ARCHIVE_CHECK_FAIL:', e.message); process.exit(1); });
