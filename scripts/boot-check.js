// Boot check (task 20, Maya msg 62883447): under a slow network no frame may ever show the
// chat view without the rail (or with the pre-workspaces header) while the splash is not
// covering it. A rAF probe installed before any script runs records every layout change
// through a hard reload, a /c/<name> deep link and a signed-out /login redirect; a join
// page (not a member) must appear with the splash lifted. The splash must also be the
// FIRST paint and fully opaque whenever the chat view is displayed under it: a fade-in
// let a fast boot show half-rendered content through it (Maya, reply 4abccc72), so the
// same runs repeat with no added latency.
// Run: NODE_PATH=<puppeteer dir> SERVER=http://localhost:8095 OUT=<dir> node scripts/boot-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman, loginPage, uniqUser } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';
require('fs').mkdirSync(OUT, { recursive: true });
const LATENCY = Number(process.env.LATENCY || 600);
async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, { method: opts.method || 'GET', headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { Authorization: 'Bearer ' + opts.token } : {}), body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}
const PROBE = () => {
  window.__frames = [];
  const vis = (el) => !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  const tick = () => {
    const chat = document.getElementById('chat-view'), splash = document.getElementById('splash');
    const rail = document.getElementById('ws-rail'), head = document.getElementById('room-head');
    const op = splash ? Number(getComputedStyle(splash).opacity) : 0;
    const f = { t: Math.round(performance.now()), chat: vis(chat), splash: vis(splash), opaque: vis(splash) && op >= 1, rail: vis(rail), oldHead: vis(head) };
    const last = window.__frames[window.__frames.length - 1];
    if (!last || ['chat', 'splash', 'opaque', 'rail', 'oldHead'].some((k) => last[k] !== f[k])) window.__frames.push(f);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
(async () => {
  const created = await newRoom(SERVER, 'boot check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await openAsHuman(page, SERVER, slug, alice);
  await page.waitForSelector('#ws-rail:not(.hidden)', { timeout: 8000 });
  await page.evaluateOnNewDocument(PROBE);
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY, downloadThroughput: 200 * 1024, uploadThroughput: 200 * 1024 });
  const runs = [['reload', () => page.reload({ waitUntil: 'domcontentloaded' })], ['deeplink', () => page.goto(SERVER + '/r/' + slug + '/c/general', { waitUntil: 'domcontentloaded' })]];
  let bad = 0;
  // the slow pass catches a layout that settles in steps; the fast pass (no latency,
  // a local server) catches content painted before the splash is fully opaque
  for (const [pass, latency] of [['slow', LATENCY], ['fast', 0]]) {
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: latency ? 200 * 1024 : -1, uploadThroughput: latency ? 200 * 1024 : -1 });
    for (const [run, go] of runs) {
      const name = pass + '-' + run;
      const nav = go();
      const shotEvery = latency ? 250 : 40, shots = latency ? 14 : 12;
      for (let i = 0; i < shots; i++) {
        await new Promise((r) => setTimeout(r, shotEvery));
        try { await page.screenshot({ path: `${OUT}/boot-${name}-${String(i).padStart(2, '0')}.png` }); } catch { /* mid-navigation */ }
      }
      await nav;
      await page.waitForSelector('#ws-rail:not(.hidden)', { timeout: 15000 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('splash')).display === 'none', { timeout: 15000 });
      const frames = await page.evaluate(() => window.__frames);
      console.log(name, JSON.stringify(frames));
      const stale = frames.filter((f) => f.chat && !f.splash && (!f.rail || f.oldHead));
      if (stale.length) { bad++; console.error(name + ': STALE LAYOUT FRAMES ' + JSON.stringify(stale)); }
      // no pre-skeleton content: the first frame is the opaque splash alone, and every
      // frame that displays the chat view under the splash keeps the splash opaque
      const first = frames[0];
      if (!first || !first.opaque || first.chat) { bad++; console.error(name + ': FIRST FRAME IS NOT THE SPLASH ' + JSON.stringify(first)); }
      const seeThrough = frames.filter((f) => f.chat && f.splash && !f.opaque);
      if (seeThrough.length) { bad++; console.error(name + ': CONTENT UNDER A TRANSLUCENT SPLASH ' + JSON.stringify(seeThrough)); }
    }
  }
  // /login redirect: a signed-out load must show only the splash until the login page paints
  await page.evaluate(() => localStorage.removeItem('agentchat:session'));
  const nav = page.goto(SERVER + '/r/' + slug, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 250)); try { await page.screenshot({ path: `${OUT}/boot-login-${i}.png` }); } catch {} }
  await nav;
  await page.waitForSelector('#login-view:not(.hidden), #login-username', { timeout: 15000 });
  const lf = await page.evaluate(() => window.__frames);
  const lstale = lf.filter((f) => f.chat && !f.splash);
  console.log('login', JSON.stringify(lf));
  if (lstale.length) { bad++; console.error('login: STALE ' + JSON.stringify(lstale)); }
  // a signed-in non-member lands on the join page with the splash gone (the form must be clickable)
  await loginPage(page, SERVER, uniqUser(), { displayName: 'stranger', next: '/r/' + slug });
  await page.waitForSelector('#enter-view:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('splash')).display === 'none' && !document.body.classList.contains('booting'), { timeout: 15000 });
  await page.screenshot({ path: `${OUT}/boot-join.png` });
  await browser.close();
  if (bad) { console.error('BOOT_CHECK_FAIL'); process.exit(1); }
  console.log('BOOT_CHECK_OK');
})().catch((e) => { console.error('BOOT_CHECK_FAIL:', e.message); process.exit(1); });
