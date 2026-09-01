// E2E: opening a thread also switches the main column to the thread's channel.
// Regression: clicking a thread leaf under another channel in the sidebar used
// to open the panel while the previous channel stayed in the main column.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/threadswitch-check.js
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
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'threadswitch check' } });
  const slug = created.room.slug;
  const agent = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'switchbot', description: 't' } });
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', avatar: '🧑', is_human: true } });
  await api('/api/v1/channels', { method: 'POST', token: agent.token, body: { name: 'deep', topic: '' } });
  await api('/api/v1/channels/deep/join', { method: 'POST', token: viewer.token });
  const root = await api('/api/v1/channels/deep/messages', { method: 'POST', token: agent.token, body: { body: 'root in deep' } });
  // the sidebar tree lists only involved threads; the mention involves the viewer
  await api('/api/v1/channels/deep/messages', { method: 'POST', token: agent.token, body: { body: 'a reply for @viewer', thread_root_id: root.id } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  // baseline: the main column shows #general
  await page.waitForFunction(() =>
    document.querySelector('#channel-list li.active')?.textContent.includes('general'), { timeout: 8000 });

  // click the thread leaf that nests under #deep in the sidebar tree
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li.thread-leaf')].some((li) => li.textContent.includes('root in deep')), { timeout: 8000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('#channel-list li.thread-leaf')]
      .find((li) => li.textContent.includes('root in deep')).click();
  });

  // the thread panel opens AND the main column switches to #deep
  await page.waitForFunction(() => !document.querySelector('#thread-panel').classList.contains('hidden'), { timeout: 8000 });
  await page.waitForFunction(() =>
    document.querySelector('#channel-title')?.textContent.includes('deep'), { timeout: 8000 })
    .catch(() => { throw new Error('main column did not switch to #deep, title=' + ''); });
  const title = await page.evaluate(() => document.querySelector('#channel-title').textContent);
  assert(title.includes('deep'), 'main column shows ' + title + ', want # deep');
  const url = await page.evaluate(() => location.pathname);
  assert(url === '/r/' + slug + '/c/deep/t/' + root.id, 'URL is ' + url + ', want /c/deep/t/<root>');
  const feed = await page.evaluate(() => document.querySelector('#messages').textContent);
  assert(feed.includes('root in deep'), 'feed does not show the deep channel messages');

  await browser.close();
  console.log('THREADSWITCH_CHECK_OK');
})().catch((e) => { console.error('THREADSWITCH_CHECK_FAIL:', e.message); process.exit(1); });
