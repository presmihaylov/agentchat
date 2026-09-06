// E2E for instant, whole workspace switching (task 23). A user with three
// workspaces boots into the first; the check holds every request of the third
// workspace at the proxy, so it stays cold. 1. A click on the cold mark keeps
// the first workspace on screen with a thin progress bar; the held requests are
// released in two stages and no region changes between them; when the last one
// lands, header, channel list, participants and messages all change in one
// frame. 2. Under Slow 3G, a switch back to a warm workspace paints with zero
// requests before the paint, and every region changes in one frame. 3. A post
// in a background workspace lands in the store through the shared feed: the
// rail badge appears, and the switch there shows the message with no fetch.
// 4. Back/forward across workspaces switches in place.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/switch-check.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { call, createRoom, registerAndLogin, loginPage, openWorkspace, uniqUser, sleep } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let step = 'setup';
const shot = (page, name) => page.screenshot({ path: path.join(OUT, 'switch-' + name) });
const REGIONS = ['#room-name', '#channel-list', '#participant-list', '#messages', '#channel-title'];

// in-page probe: every fetch and every first-mutation-after-mark per region,
// on one clock (performance.now), so "before the paint" is measurable
const PROBE = `(() => {
  window.__probe = { reqs: [], marks: {}, paints: [] };
  const rawFetch = window.fetch;
  window.fetch = function (url, opts) { window.__probe.reqs.push({ url: String(url), t: performance.now() }); return rawFetch.apply(this, arguments); };
  window.__watch = (ids) => {
    window.__probe.marks = {}; window.__probe.reqs = []; window.__probe.paints = [];
    window.__probe.t0 = performance.now();
    for (const id of ids) {
      const el = document.querySelector(id);
      const mo = new MutationObserver(() => {
        if (window.__probe.marks[id] === undefined) {
          window.__probe.marks[id] = performance.now();
          requestAnimationFrame(() => window.__probe.paints.push(performance.now()));
        }
      });
      mo.observe(el, { childList: true, subtree: true, characterData: true });
    }
  };
})()`;
const probe = (page) => page.evaluate(() => window.__probe);
const watch = (page) => page.evaluate((ids) => window.__watch(ids), REGIONS);
const regionText = (page) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.querySelector(id).textContent.replace(/\s+/g, " ").trim().slice(0, 400)])), REGIONS);
const spreadOf = (marks) => { const ts = Object.values(marks); return Math.max(...ts) - Math.min(...ts); };
const waitSwapped = (page, slug) => page.waitForFunction((s) => location.pathname.startsWith('/w/' + s) && document.querySelector('#rail-list .rail-item[aria-current="true"][data-slug="' + s + '"]'), { timeout: 15000 }, slug);
const progressShown = (page) => page.$eval('#switch-progress', (el) => !el.classList.contains('hidden'));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument(PROBE);

  // A owns alpha, beta and gamma; B enters beta and posts there later
  const session = await loginPage(page, SERVER, uniqUser(), { displayName: 'Ava Switcher' });
  const alpha = await createRoom(SERVER, session, 'alpha base');
  const beta = await createRoom(SERVER, session, 'beta camp');
  const gamma = await createRoom(SERVER, session, 'gamma post');
  const post = (ws, token, body) => call(SERVER, '/api/v1/channels/general/messages', { method: 'POST', token, headers: { 'X-Workspace-Slug': ws.room.slug }, body: { body } });
  for (const [ws, text] of [[alpha, 'alpha says hi'], [beta, 'beta says hi'], [gamma, 'gamma says hi']]) await post(ws, session, text);
  await call(SERVER, '/api/v1/channels', { method: 'POST', token: session, headers: { 'X-Workspace-Slug': gamma.room.slug }, body: { name: 'gamma-ops' } });
  const sessionB = await registerAndLogin(SERVER, uniqUser(), 'Bo Poster');
  await call(SERVER, '/api/v1/workspaces/' + beta.room.slug + '/enter', { method: 'POST', token: sessionB, body: { invite: beta.invite } });

  // gamma stays cold: its requests are held at the proxy until the check lets them go
  // (the hold starts after the page is open: networkidle would never fire otherwise)
  const held = [];
  let holdGamma = false;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (holdGamma && req.headers()['x-workspace-slug'] === gamma.room.slug) { held.push(req); return; }
    req.continue();
  });
  const release = (pred) => { const go = held.filter(pred); for (const r of go) { held.splice(held.indexOf(r), 1); r.continue(); } return go.length; };

  step = '1';
  // alpha boots; the background warm stalls on gamma's first held request
  const cdp = await page.createCDPSession();
  await page.goto(SERVER + '/login', { waitUntil: 'networkidle2' });
  await page.evaluate((t) => localStorage.setItem('agentchat:session', t), session);
  holdGamma = true;
  await page.goto(SERVER + '/w/' + alpha.room.slug, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#rail-list .rail-item').length === 3, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('alpha says hi'), { timeout: 8000 });
  // the background warm reaches beta (its pages too) and stalls on gamma
  await page.waitForFunction((s) => window.__probe.reqs.filter((r) => /\/messages\?limit=100/.test(r.url)).length >= 2, { timeout: 8000 });
  await sleep(1500);
  assert(held.length > 0, 'gamma warm never started: ' + held.length);
  const beforeCold = await regionText(page);

  // 1. the cold switch: old workspace on screen, bar on top, nothing moves
  // until the last request lands, then everything in one frame
  await watch(page);
  await page.click('#rail-list .rail-item[data-slug="' + gamma.room.slug + '"]');
  await sleep(600);
  assert(await progressShown(page), 'progress bar not shown on a cold switch');
  assert(page.url().includes('/w/' + alpha.room.slug), 'URL moved before the swap: ' + page.url());
  let mid = await regionText(page);
  assert(JSON.stringify(mid) === JSON.stringify(beforeCold), 'a region changed before the data arrived: ' + JSON.stringify(mid));
  await shot(page, 'cold-midway.png');
  // stage one: everything but the channel page and members; the warm issues
  // requests in waves, so release until only the page and members are held
  const isPage = (r) => /\/messages\?|\/members$/.test(r.url());
  let stage1 = 0;
  for (let i = 0; i < 30; i++) {
    stage1 += release((r) => !isPage(r));
    await sleep(300);
    if (held.some(isPage) && !held.some((r) => !isPage(r))) break;
  }
  assert(stage1 >= 4 && held.some(isPage), 'stage one released ' + stage1 + ', held ' + held.map((r) => r.url()).join(' '));
  await sleep(1000);
  mid = await regionText(page);
  assert(JSON.stringify(mid) === JSON.stringify(beforeCold), 'a region changed after stage one: ' + JSON.stringify(mid));
  assert(await progressShown(page), 'progress bar gone after stage one');
  assert(Object.keys((await probe(page)).marks).length === 0, 'a region mutated before the messages arrived');
  // stage two: the page and the members of #general
  release(() => true);
  await waitSwapped(page, gamma.room.slug);
  const cold = await probe(page);
  assert(Object.keys(cold.marks).length === REGIONS.length, 'regions that changed on the cold switch: ' + JSON.stringify(cold.marks));
  assert(spreadOf(cold.marks) < 50, 'cold switch staggered: ' + JSON.stringify(cold.marks));
  assert(!(await progressShown(page)), 'progress bar left on after the swap');
  const after = await regionText(page);
  assert(after['#room-name'] === 'gamma post' && after['#messages'].includes('gamma says hi') && after['#channel-list'].includes('gamma-ops'), 'gamma not whole: ' + JSON.stringify(after));
  await shot(page, 'cold-after.png');
  holdGamma = false;
  release(() => true);

  step = '2';
  // 2. Slow 3G: the switch back to alpha (warm) paints with zero requests before it
  const slow3G = { offline: false, latency: 2000, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 50 * 1024 / 8 };
  await cdp.send('Network.emulateNetworkConditions', slow3G);
  await watch(page);
  const t0 = Date.now();
  await page.click('#rail-list .rail-item[data-slug="' + alpha.room.slug + '"]');
  await waitSwapped(page, alpha.room.slug);
  const warm = await probe(page);
  const firstPaint = Math.min(...warm.paints);
  const before = warm.reqs.filter((r) => r.t < firstPaint);
  assert(before.length === 0, 'requests before the paint on a warm switch: ' + JSON.stringify(before));
  assert(Object.keys(warm.marks).length === REGIONS.length && spreadOf(warm.marks) < 50, 'warm switch staggered: ' + JSON.stringify(warm.marks));
  assert(Date.now() - t0 < 1000, 'warm switch took ' + (Date.now() - t0) + 'ms under Slow 3G');
  const alphaNow = await regionText(page);
  assert(alphaNow['#room-name'] === 'alpha base' && alphaNow['#messages'].includes('alpha says hi'), 'alpha not whole: ' + JSON.stringify(alphaNow));
  await shot(page, 'warm-after.png');

  step = '3';
  // 3. B posts in beta while alpha is on screen: the feed puts it in the store,
  // the rail badge shows, and the switch there shows it with no fetch first
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await post(beta, sessionB, 'fresh from beta');
  await page.waitForFunction((s) => { const b = document.querySelector('#rail-list .rail-item[data-slug="' + s + '"] .rail-badge'); return b && !b.classList.contains('hidden') && b.textContent === '1'; }, { timeout: 8000 }, beta.room.slug);
  await page.waitForFunction(() => document.title.startsWith('(1) '), { timeout: 4000 });
  await shot(page, 'badge.png');
  await cdp.send('Network.emulateNetworkConditions', slow3G);
  await watch(page);
  await page.click('#rail-list .rail-item[data-slug="' + beta.room.slug + '"]');
  await waitSwapped(page, beta.room.slug);
  const live = await probe(page);
  assert(live.reqs.filter((r) => r.t < Math.min(...live.paints)).length === 0, 'requests before the paint on the live switch');
  const betaNow = await regionText(page);
  assert(betaNow['#messages'].includes('fresh from beta'), 'the background post is not in the store: ' + JSON.stringify(betaNow));
  assert(await page.$eval('#messages', (el) => !!el.querySelector('.unread-divider')), 'no new-messages divider for the background post');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.waitForFunction((s) => document.querySelector('#rail-list .rail-item[data-slug="' + s + '"] .rail-badge').classList.contains('hidden'), { timeout: 8000 }, beta.room.slug);
  await shot(page, 'live.png');

  step = '4';
  // 4. back and forward move between workspaces in place
  await page.goBack();
  await waitSwapped(page, alpha.room.slug);
  await page.waitForFunction(() => document.querySelector('#room-name').textContent === 'alpha base', { timeout: 8000 });
  await page.goForward();
  await waitSwapped(page, beta.room.slug);
  await page.waitForFunction(() => document.querySelector('#room-name').textContent === 'beta camp', { timeout: 8000 });
  const navs = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  assert(navs === 1, 'a switch reloaded the page: ' + navs + ' navigations');

  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  console.log('SWITCH_CHECK_OK');
  await browser.close();
})().catch(async (e) => {
  console.error('step ' + step + ': ' + e.message);
  process.exit(1);
});
