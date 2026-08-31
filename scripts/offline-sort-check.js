// E2E: in the participants tree, an expanded human's owned agents sort online-first;
// offline agents sink below the online ones (Chief bugfix). Ownership nesting stays.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/offline-sort-check.js
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

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'offline sort check' } });
  const slug = created.room.slug, code = created.invite_code;
  // human H is the first joiner (admin); mint an owner-scoped code so agents nest under H.
  const H = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'boss', avatar: '🧑', is_human: true } });
  const owned = await api('/api/v1/invites', { method: 'POST', token: H.token });
  const ocode = owned.invite_code;
  // four agents owned by H: join order on1, off1, on2, off2 (interleaved on purpose).
  const on1 = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: ocode, name: 'on-alpha', avatar: '🤖' } });
  const off1 = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: ocode, name: 'off-bravo', avatar: '🤖' } });
  const on2 = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: ocode, name: 'on-charlie', avatar: '🤖' } });
  const off2 = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: ocode, name: 'off-delta', avatar: '🤖' } });
  // mark two of them offline immediately via their own token.
  await api('/api/v1/me/offline', { method: 'POST', token: off1.token });
  await api('/api/v1/me/offline', { method: 'POST', token: off2.token });
  // keep the online ones fresh.
  await api('/api/v1/me/heartbeat', { method: 'POST', token: on1.token });
  await api('/api/v1/me/heartbeat', { method: 'POST', token: on2.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, H.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#participant-list li', { timeout: 6000 });

  // reveal offline participants (the global offline toggle at the bottom).
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('#participant-list li.offline-toggle')][0];
    if (t) t.click();
  });
  // expand H's agent list (click the human row's chevron/toggle).
  await page.waitForFunction((name) => {
    return [...document.querySelectorAll('#participant-list li')].some((li) => (li.querySelector('.pname') || {}).textContent === name);
  }, { timeout: 4000 }, 'boss');
  await page.evaluate((name) => {
    const li = [...document.querySelectorAll('#participant-list li')].find((x) => (x.querySelector('.pname') || {}).textContent === name);
    (li.querySelector('.p-toggle') || li).click(); // the chevron expands; the row itself opens a profile
  }, 'boss');

  // read the rendered order of H's four owned agents (nested rows, in DOM order).
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('#participant-list li .pname')].map((e) => e.textContent);
    return ['on-alpha', 'off-bravo', 'on-charlie', 'off-delta'].every((n) => names.includes(n));
  }, { timeout: 4000 });

  const rows = await page.$$eval('#participant-list li', (lis) => lis
    .filter((li) => li.querySelector('.pname'))
    .map((li) => ({ name: li.querySelector('.pname').textContent, offline: li.classList.contains('offline') })));

  // isolate the four owned agents in render order.
  const agentNames = ['on-alpha', 'off-bravo', 'on-charlie', 'off-delta'];
  const seq = rows.filter((r) => agentNames.includes(r.name));
  const order = seq.map((r) => r.name);

  // every online agent must precede every offline agent in the parent's list.
  const firstOffline = seq.findIndex((r) => r.offline);
  const lastOnline = seq.map((r) => r.offline).lastIndexOf(false);
  if (firstOffline === -1) throw new Error('no offline agents rendered (offline toggle did not reveal them): ' + JSON.stringify(order));
  if (lastOnline > firstOffline) throw new Error('offline agent mixed above an online one: ' + JSON.stringify(order));
  // sanity: the two online and two offline all present.
  const onlineCount = seq.filter((r) => !r.offline).length;
  if (onlineCount !== 2 || seq.length !== 4) throw new Error('unexpected agent set: ' + JSON.stringify(seq));

  await browser.close();
  console.log('OFFLINE_SORT_CHECK_OK order=' + JSON.stringify(order));
})().catch((e) => { console.error('OFFLINE_SORT_CHECK_FAIL:', e.message); process.exit(1); });
