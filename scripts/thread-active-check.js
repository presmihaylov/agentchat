// E2E: selecting a thread highlights its leaf in the sidebar (Maya FR seq 339).
// A thread leaf gets the same accent active-state as a channel while its thread
// is open; opening another leaf moves the highlight; closing the thread clears
// it. The active leaf also suppresses its unread glow (no double emphasis).
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/thread-active-check.js
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

// active-leaf state read from the live DOM
const leaves = (page) => page.evaluate(() => {
  const lis = [...document.querySelectorAll('#channel-list li.thread-leaf')];
  return lis.map((li) => {
    const bg = getComputedStyle(li).backgroundColor;
    const cs = getComputedStyle(li);
    return { snippet: (li.querySelector('.t-snippet') || {}).textContent || '', active: li.classList.contains('active'), bg, radius: cs.borderRadius };
  });
});
const clickLeaf = (page, snippetPrefix) => page.evaluate((pre) => {
  const li = [...document.querySelectorAll('#channel-list li.thread-leaf')]
    .find((x) => (x.querySelector('.t-snippet') || {}).textContent.startsWith(pre));
  li.click();
}, snippetPrefix);
const isAccent = (bg) => {
  const m = bg.match(/\d+/g);
  return m && Number(m[2]) > Number(m[0]) && Number(m[2]) > 120; // bluish accent fill
};

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'thread active check' } });
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'threadbot', avatar: '🤖' } });
  // two distinct threads, so we can prove the highlight MOVES between leaves
  const rootA = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'alpha root' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'a reply', thread_root_id: rootA.id } });
  const rootB = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'bravo root' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'b reply', thread_root_id: rootB.id } });
  // human joins and replies to both, so both leaves nest in her sidebar
  const human = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'humantester', avatar: '🧑', is_human: true } });
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
  await page.waitForSelector('#channel-list li.thread-leaf', { timeout: 6000 });

  // 0) BASELINE: two leaves, none active
  let ls = await leaves(page);
  if (ls.length < 2) throw new Error('expected two thread leaves, got ' + JSON.stringify(ls));
  if (ls.some((l) => l.active)) throw new Error('no leaf should be active before a thread opens: ' + JSON.stringify(ls));

  // 1) OPEN ALPHA: its leaf goes active with an accent fill; bravo stays plain
  await clickLeaf(page, 'alpha');
  await page.waitForFunction(() => !document.querySelector('#thread-panel').classList.contains('hidden'), { timeout: 6000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#channel-list li.thread-leaf')].some((li) => li.classList.contains('active')), { timeout: 3000 });
  ls = await leaves(page);
  const alpha = ls.find((l) => l.snippet.startsWith('alpha'));
  const bravo = ls.find((l) => l.snippet.startsWith('bravo'));
  if (!alpha.active) throw new Error('alpha leaf should be active: ' + JSON.stringify(ls));
  if (bravo.active) throw new Error('bravo leaf should stay inactive: ' + JSON.stringify(ls));
  if (!isAccent(alpha.bg)) throw new Error('active leaf should have an accent fill, got ' + alpha.bg);
  // Maya FR: the highlight is rounded on every corner, not square down its left
  // edge, and translucent enough to read as a highlight over the sidebar
  if (/^0px/.test(alpha.radius) || !/^\d+px$/.test(alpha.radius)) throw new Error('leaf highlight is not evenly rounded: ' + alpha.radius);
  const alphaChan = Number((alpha.bg.match(/[\d.]+/g) || [])[3]);
  if (!(alphaChan > 0 && alphaChan < 1)) throw new Error('active fill should be translucent, got ' + alpha.bg);

  // 2) MOVE TO BRAVO: highlight follows, alpha clears (only one active at a time)
  await clickLeaf(page, 'bravo');
  await page.waitForFunction(() => {
    const li = [...document.querySelectorAll('#channel-list li.thread-leaf')].find((x) => (x.querySelector('.t-snippet') || {}).textContent.startsWith('bravo'));
    return li && li.classList.contains('active');
  }, { timeout: 3000 });
  ls = await leaves(page);
  if (ls.find((l) => l.snippet.startsWith('alpha')).active) throw new Error('alpha should clear when bravo opens: ' + JSON.stringify(ls));
  if (!ls.find((l) => l.snippet.startsWith('bravo')).active) throw new Error('bravo should be active: ' + JSON.stringify(ls));

  // 3) CLOSE THREAD: highlight clears entirely
  await page.click('#thread-close');
  await page.waitForFunction(() => document.querySelector('#thread-panel').classList.contains('hidden'), { timeout: 6000 });
  ls = await leaves(page);
  if (ls.some((l) => l.active)) throw new Error('no leaf should stay active after closing the thread: ' + JSON.stringify(ls));

  await browser.close();
  if (!process.exitCode) console.log('THREAD_ACTIVE_CHECK_OK');
})().catch((e) => { console.error('THREAD_ACTIVE_CHECK_FAIL:', e.message); process.exit(1); });
