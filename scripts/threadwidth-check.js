// E2E: the thread panel opens at its wider default (~504px, was 360px).
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/threadwidth-check.js
// Needs a server on $SERVER (default :8095) backed by a live Postgres.
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
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

(async () => {
  const created = await newRoom(SERVER, 'thread width check');
  const code = created.invite_code, slug = created.room.slug;
  const sender = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'sender', avatar: '🤖' } });
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'viewer', avatar: '🧑', is_human: true } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: sender.token, body: { body: 'open me' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: sender.token, body: { body: 'a reply', thread_root_id: root.id } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));
  await openAsHuman(page, SERVER, slug, viewer);
  // the /t/<id> route auto-opens the thread panel on load
  await page.goto(SERVER + '/r/' + slug + '/c/general/t/' + root.id, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#thread-panel:not(.hidden)', { timeout: 6000 });

  const w = await page.evaluate(() => document.getElementById('thread-panel').getBoundingClientRect().width);
  if (Math.abs(w - 504) > 2) fail(`thread panel width = ${w}px, want ~504px`);

  await browser.close();
  if (!process.exitCode) console.log('THREADWIDTH_CHECK_OK width=' + w);
})().catch((e) => { console.error(e); process.exit(1); });
