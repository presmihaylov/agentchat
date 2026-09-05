// E2E for per-workspace badges in the rail (task 13). A belongs to two
// workspaces and sits in the first; B posts an @mention of A in the second.
// After the focus refresh, A's rail shows "1" on the second mark; a plain
// post shows a dot instead; opening the second workspace clears its badge and
// it stays clear on the way back.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/railbadge-check.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { call, createRoom, registerAndLogin, loginPage, openWorkspace, uniqUser } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || '.';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let step = 'setup';
const shot = (page, name) => page.screenshot({ path: path.join(OUT, 'railbadge-' + name) });
const badgeOf = (page, slug) => page.$eval('#rail-list .rail-item[href="/w/' + slug + '"] .rail-badge', (b) => ({ hidden: b.classList.contains('hidden'), count: b.classList.contains('count'), text: b.textContent }));
// the tab regaining focus is the immediate refresh; the 60 s timer is the slow path
const refocus = (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const waitBadge = (page, slug, want) => page.waitForFunction((s, w) => {
  const b = document.querySelector('#rail-list .rail-item[href="/w/' + s + '"] .rail-badge');
  if (!b) return false;
  const st = b.classList.contains('hidden') ? 'none' : b.classList.contains('count') ? 'count:' + b.textContent : 'dot';
  return st === w;
}, { timeout: 8000 }, slug, want);

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

  // A owns "home" and "away"; B enters "away" and posts there
  const session = await loginPage(page, SERVER, uniqUser(), { displayName: 'avabadge' });
  const home = await createRoom(SERVER, session, 'home base');
  const away = await createRoom(SERVER, session, 'away team');
  const sessionB = await registerAndLogin(SERVER, uniqUser(), 'Bo Poster');
  await call(SERVER, '/api/v1/workspaces/' + away.room.slug + '/enter', { method: 'POST', token: sessionB, body: { invite_code: away.invite_code } });
  const postAway = (body) => call(SERVER, '/api/v1/channels/general/messages', { method: 'POST', token: sessionB, headers: { 'X-Workspace-Slug': away.room.slug }, body: { body } });

  step = '1';
  // 1. clean rail in home; nothing on away
  await openWorkspace(page, SERVER, session, home.room.slug);
  await page.waitForFunction(() => document.querySelectorAll('#rail-list .rail-item').length === 2, { timeout: 8000 });
  assert((await badgeOf(page, away.room.slug)).hidden, 'away badged before any post');
  assert((await badgeOf(page, home.room.slug)).hidden, 'home badged');

  step = '2';
  // 2. a plain post from B: a dot on away after the focus refresh
  await postAway('news from away');
  await refocus(page);
  await waitBadge(page, away.room.slug, 'dot');
  await shot(page, 'dot.png');

  step = '3';
  // 3. an @mention: the dot becomes a "1" pill; the current mark stays clean
  await postAway('hey @avabadge look at this');
  await refocus(page);
  await waitBadge(page, away.room.slug, 'count:1');
  assert((await badgeOf(page, home.room.slug)).hidden, 'home badged by away traffic');
  const label = await page.$eval('#rail-list .rail-item[href="/w/' + away.room.slug + '"]', (a) => a.getAttribute('aria-label'));
  assert(label === 'away team, 1 mentions', 'aria-label: ' + label);
  // the count badge is the alert red with a white bold count (task 20, Maya msg 4561407a)
  const paint = await page.$eval('#rail-list .rail-item[href="/w/' + away.room.slug + '"] .rail-badge', (b) => { const c = getComputedStyle(b); return { bg: c.backgroundColor, fg: c.color, weight: c.fontWeight }; });
  assert(paint.bg === 'rgb(237, 66, 69)' && paint.fg === 'rgb(255, 255, 255)' && Number(paint.weight) >= 600, 'badge paint: ' + JSON.stringify(paint));
  await shot(page, 'mention.png');

  step = '4';
  // 4. opening away clears it (the channel read marker is written on open)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }),
    page.click('#rail-list .rail-item[href="/w/' + away.room.slug + '"]'),
  ]);
  await page.waitForFunction(() => document.querySelectorAll('#rail-list .rail-item').length === 2, { timeout: 8000 });
  await page.waitForSelector('.msg', { timeout: 8000 });
  await waitBadge(page, away.room.slug, 'none');
  await shot(page, 'opened.png');

  step = '5';
  // 5. back in home, a refresh still shows away clean: the marker stuck
  await openWorkspace(page, SERVER, session, home.room.slug);
  await page.waitForFunction(() => document.querySelectorAll('#rail-list .rail-item').length === 2, { timeout: 8000 });
  await refocus(page);
  await new Promise((r) => setTimeout(r, 800));
  assert((await badgeOf(page, away.room.slug)).hidden, 'away still badged after being read');
  await shot(page, 'clear.png');

  await browser.close();
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  console.log('RAILBADGE_CHECK_OK');
})().catch((e) => { console.error('FAIL at step ' + step + ': ' + e.message); process.exit(1); });
