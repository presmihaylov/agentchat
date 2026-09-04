// E2E for right-click Subscribe: an uninvolved viewer subscribes to a message
// via its context menu, the thread lands in the sidebar tree, new activity
// glows it, and Unsubscribe from the leaf menu removes it.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/subscribe-check.js
const puppeteer = require('puppeteer-core');
const { newRoom } = require('./lib/login.js');
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
  const created = await newRoom(SERVER, 'subscribe check');
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'subbot', description: 't' } });
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', is_human: true } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'subscribable topic here' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'first reply', thread_root_id: root.id } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // seed the legacy token on a neutral page first: a room load without it
  // bounces to /login and a reload there never comes back
  await page.goto(SERVER + '/login', { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#messages .msg')]
    .some((n) => n.textContent.includes('subscribable topic')), { timeout: 8000 });

  // the viewer never posted: the sidebar tree must be empty
  assert(await page.$('#channel-list .thread-leaf') === null, 'uninvolved viewer already has a leaf');

  // right-click the root message and pick Subscribe
  const rightClickMsg = (needle) => page.evaluate((txt) => {
    const el = [...document.querySelectorAll('#messages .msg')].find((n) => n.textContent.includes(txt));
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 8 }));
  }, needle);
  const pickMenuItem = async (label) => {
    await page.waitForSelector('.context-menu', { timeout: 4000 });
    const ok = await page.evaluate((want) => {
      const b = [...document.querySelectorAll('.context-menu .ctx-item')].find((x) => x.textContent === want);
      if (!b) return [...document.querySelectorAll('.context-menu .ctx-item')].map((x) => x.textContent).join('|');
      b.click(); return true;
    }, label);
    assert(ok === true, 'menu item "' + label + '" missing, saw: ' + ok);
  };
  await rightClickMsg('subscribable topic');
  await pickMenuItem('Subscribe');
  await page.waitForFunction(() => [...document.querySelectorAll('#channel-list .thread-leaf')]
    .some((n) => n.textContent.includes('subscribable topic')), { timeout: 8000 });
  console.log('leaf appeared after subscribe');

  // a second right-click offers Unsubscribe (state round-trips)
  await rightClickMsg('subscribable topic');
  await pickMenuItem('Unsubscribe');
  await page.waitForFunction(() => !document.querySelector('#channel-list .thread-leaf'), { timeout: 8000 });
  console.log('leaf gone after unsubscribe from message menu');

  // subscribe again, mark read, then new bot activity must glow the leaf
  await rightClickMsg('subscribable topic');
  await pickMenuItem('Subscribe');
  await page.waitForSelector('#channel-list .thread-leaf', { timeout: 8000 });
  await api('/api/v1/threads/' + root.id + '/read', { method: 'POST', token: viewer.token, body: {} });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'fresh activity', thread_root_id: root.id } });
  await page.waitForFunction(() => {
    const leaf = document.querySelector('#channel-list .thread-leaf');
    return leaf && leaf.classList.contains('unread');
  }, { timeout: 8000 });
  console.log('leaf glows on new activity');
  await page.screenshot({ path: (process.env.OUT || '.') + '/subscribe-glow.png' });

  // unsubscribe from the leaf's own context menu
  await page.evaluate(() => {
    const leaf = document.querySelector('#channel-list .thread-leaf');
    const r = leaf.getBoundingClientRect();
    leaf.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 }));
  });
  await pickMenuItem('Unsubscribe');
  await page.waitForFunction(() => !document.querySelector('#channel-list .thread-leaf'), { timeout: 8000 });
  console.log('leaf gone after unsubscribe from leaf menu');

  await browser.close();
  console.log('SUBSCRIBE_CHECK_OK');
})().catch((e) => { console.error('SUBSCRIBE_CHECK_FAIL:', e.message); process.exit(1); });
