// Headless check of the session-driven room entry (task 03): a signed-in user
// creates a workspace on /create and lands in it as admin, a second user meets
// #enter-view and gets in with the invite code, a revoked user sees the removed
// notice, a legacy act_ human (per-slug token, no session) bounces to sign in
// with the key scrubbed, a visitor with neither goes to /login?next=, and a stale
// session on a room page bounces to /login?next=.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8090 node scripts/enter-check.js
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { call, loginPage, enterWithCode, uniqUser } = require('./lib/login.js');

const SERVER = process.env.SERVER || 'http://localhost:8095';
const SHOTS = process.env.SHOTS_DIR || '';

let lastStep = 'start';
const shot = async (page, name) => { lastStep = 'shot ' + name; if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
const visible = (page, sel) => { lastStep = 'wait ' + sel; return page.waitForSelector(sel + ':not(.hidden)', { timeout: 8000 }); };
const hiddenNow = (page, sel) => page.$eval(sel, (el) => el.classList.contains('hidden'));
const roomApi = (p, session, slug, opts = {}) => call(SERVER, p, Object.assign({ token: session, headers: { 'X-Workspace-Slug': slug } }, opts));

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];
  const statuses = []; // [url, status, code] of every API response any page saw
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('response', (r) => {
      if (!r.url().includes('/api/v1/')) return;
      const entry = [r.url(), r.status(), null];
      statuses.push(entry);
      r.json().then((d) => { entry[2] = d && d.code; }, () => {});
    });
    if (process.env.DEBUG) {
      page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.error('resp', r.status(), r.url()); });
      page.on('console', (m) => console.error('console', m.type(), m.text()));
    }
  };
  // one page per identity: each browser context owns its localStorage
  const freshPage = async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    watch(page);
    return page;
  };
  const openAs = async (session) => {
    const page = await freshPage();
    await page.goto(SERVER + '/login', { waitUntil: 'networkidle2' });
    if (session) await page.evaluate((t) => localStorage.setItem('agentchat:session', t), session);
    return page;
  };
  const lastResponse = (frag) => [...statuses].reverse().find(([u]) => u.includes(frag));

  // A creates the workspace in the browser and lands in it as admin
  const pageA = await freshPage();
  const sessionA = await loginPage(pageA, SERVER, uniqUser(), { displayName: 'Alice Creator', next: '/create' });
  await visible(pageA, '#create-view');
  if (await pageA.$('#create-user-name')) throw new Error('the create form still asks for a name');
  await pageA.type('#create-room-name', 'enter check');
  // the slug derives from the fixed name; a rerun would collide, so override it as a user could
  await pageA.$eval('#create-room-slug', (el, v) => { el.value = v; }, 'enter-check-' + uniqUser().slice(-8));
  await shot(pageA, 'create.png');
  await pageA.click('#create-form button[type=submit]');
  await pageA.waitForFunction(() => location.pathname.startsWith('/w/'), { timeout: 8000 });
  const slug = new URL(pageA.url()).pathname.split('/')[2];
  await visible(pageA, '#chat-view');
  await pageA.waitForFunction(() => document.querySelector('#room-name').textContent === 'enter check', { timeout: 8000 });
  await pageA.waitForFunction(() => document.querySelector('#participant-list').textContent.includes('Alice Creator'), { timeout: 8000 });
  await shot(pageA, 'room-as-creator.png');
  const created = lastResponse('/api/v1/rooms');
  if (!created || created[1] !== 201) throw new Error('create response: ' + JSON.stringify(created));
  if (await pageA.evaluate((k) => localStorage.getItem(k), 'agentchat:' + slug) !== null) throw new Error('legacy per-slug key written for a session user');
  const meA = await roomApi('/api/v1/me', sessionA, slug);
  if (meA.role !== 'admin' || meA.name !== 'Alice Creator' || !meA.user_id) throw new Error('creator identity: ' + JSON.stringify(meA));
  const roomA = await roomApi('/api/v1/room', sessionA, slug);
  const code = roomA.invite_code;
  if (!code) throw new Error('admin sees no invite code');

  // B is signed in but not a member: the enter view, wrong code, right code
  const pageB = await freshPage();
  const sessionB = await loginPage(pageB, SERVER, uniqUser(), { displayName: 'Bob Entrant', next: '/r/' + slug });
  await visible(pageB, '#enter-view');
  if (await pageB.$('#join-view')) throw new Error('the legacy join view is still in the page');
  await pageB.waitForFunction(() => document.querySelector('#enter-room-name').textContent.includes('enter check'), { timeout: 8000 });
  const forbidden = lastResponse('/api/v1/me');
  if (!forbidden || forbidden[1] !== 403) throw new Error('non-member /me: ' + JSON.stringify(forbidden));
  await shot(pageB, 'enter-view.png');
  await pageB.type('#enter-code', 'inv-0000-0000-0000-0000');
  await pageB.click('#enter-form button[type=submit]');
  await visible(pageB, '#enter-error');
  await pageB.waitForFunction(() => /does not open this workspace/.test(document.querySelector('#enter-error').textContent), { timeout: 8000 });
  const wrong = lastResponse('/enter');
  if (!wrong || wrong[1] !== 400) throw new Error('wrong code: ' + JSON.stringify(wrong));
  await enterWithCode(pageB, code);
  await pageB.waitForFunction(() => document.querySelector('#participant-list').textContent.includes('Bob Entrant'), { timeout: 8000 });
  const meB = await roomApi('/api/v1/me', sessionB, slug);
  if (meB.role !== 'member' || meB.name !== 'Bob Entrant') throw new Error('entrant identity: ' + JSON.stringify(meB));

  // A revokes B; B's next load meets the removed notice
  await roomApi('/api/v1/participants/' + meB.id, sessionA, slug, { method: 'DELETE' });
  await pageB.reload({ waitUntil: 'networkidle2' });
  await visible(pageB, '#removed-view');
  if (!await hiddenNow(pageB, '#chat-view')) throw new Error('chat view shown to a revoked user');
  await shot(pageB, 'removed.png');
  const revoked = lastResponse('/api/v1/me');
  if (!revoked || revoked[1] !== 403) throw new Error('revoked /me: ' + JSON.stringify(revoked));

  // a visitor with neither a session nor a legacy token goes to sign in first
  const pageC = await openAs(null);
  await pageC.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await pageC.waitForFunction(() => location.pathname === '/login', { timeout: 8000 });
  if (new URL(pageC.url()).searchParams.get('next') !== '/r/' + slug) throw new Error('no-identity visit: ' + pageC.url());
  if (await pageC.$('#join-view')) throw new Error('the legacy join view is still in the page');
  // a legacy act_ human (a /join before accounts existed) no longer boots on
  // the per-slug token since 000027: sign in first, and the key is scrubbed
  const legacy = await call(SERVER, '/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'Legacy Human', is_human: true } });
  await pageC.evaluate((k, t) => localStorage.setItem(k, JSON.stringify({ token: t })), 'agentchat:' + slug, legacy.token);
  await pageC.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await pageC.waitForFunction(() => location.pathname === '/login', { timeout: 8000 });
  if (new URL(pageC.url()).searchParams.get('next') !== '/r/' + slug) throw new Error('legacy token visit: ' + pageC.url());
  if (await pageC.evaluate((k) => localStorage.getItem(k), 'agentchat:' + slug) !== null) throw new Error('legacy per-slug key kept');

  // a stale session on a room page goes to the login page with next
  const pageD = await openAs('ses_' + 'x'.repeat(32));
  await pageD.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await pageD.waitForFunction(() => location.pathname === '/login', { timeout: 8000 });
  if (pageD.url() !== SERVER + '/login?next=%2Fr%2F' + slug) throw new Error('stale session landed on ' + pageD.url());
  if (await pageD.evaluate(() => localStorage.getItem('agentchat:session')) !== null) throw new Error('stale session kept');

  // the expected failures (403 non-member and revoked, 400 wrong code, 401 stale
  // session) log as console errors; nothing else may
  const realErrors = errors.filter((e) => !e.includes('favicon') && !/status of (400|401|403)/.test(e));
  if (realErrors.length) throw new Error('page errors: ' + realErrors.join(' | '));
  const okCodes = { 400: ['invite_invalid'], 401: ['session_invalid', null], 403: ['workspace_forbidden'] };
  const odd = statuses.filter(([, st, c]) => st >= 400 && !(okCodes[st] || []).includes(c));
  if (odd.length) throw new Error('unexpected error responses: ' + JSON.stringify(odd));

  console.log('ENTER_CHECK_OK');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ENTER_CHECK_FAIL:', e.message, '(after: ' + lastStep + ')'); process.exit(1); });
