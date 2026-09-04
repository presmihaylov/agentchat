// E2E: themed scrollbars are applied to the scrollable regions. WebKit custom
// scrollbars do not paint in headless screenshots (Chrome uses fade-out overlay
// there), so we assert the cross-browser computed properties instead: Firefox's
// scrollbar-width:thin and a scrollbar-color built from the theme's --border on
// a transparent track. The ::-webkit-scrollbar rules ship in the same block.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/scrollbar-check.js
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

(async () => {
  const created = await newRoom(SERVER, 'scrollbar check');
  const code = created.invite_code, slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'viewer', avatar: '🧑', is_human: true } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  // seed the legacy token on a neutral page first: a room load without it
  // bounces to /login and a reload there never comes back
  await page.goto(SERVER + '/login', { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#messages', { timeout: 6000 });

  // the theme --border resolves to rgb(58, 61, 66)
  const border = 'rgb(58, 61, 66)';
  for (const sel of ['#messages', '#sidebar', '#thread-messages']) {
    const cs = await page.$eval(sel, (el) => {
      const s = getComputedStyle(el);
      return { width: s.scrollbarWidth, color: s.scrollbarColor };
    }).catch(() => null);
    if (!cs) { fail(`${sel} not found`); continue; }
    if (cs.width !== 'thin') fail(`${sel} scrollbar-width = ${cs.width}, want thin`);
    if (!cs.color.includes(border)) fail(`${sel} scrollbar-color = ${cs.color}, want thumb ${border}`);
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.color)) fail(`${sel} scrollbar track not transparent: ${cs.color}`);
  }

  await browser.close();
  if (!process.exitCode) console.log('SCROLLBAR_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
