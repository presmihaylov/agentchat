// E2E for delete workspace (task 14). The owner opens workspace settings,
// sees the Danger zone, types the name to arm the button, confirms, and lands
// on the remaining workspace; an agent token from the deleted room gets 401;
// a non-owner admin sees no Danger zone at all. The fleet-room second
// confirmation keys on the prod slug, which cannot exist on dev: that branch
// has a unit test on the predicate (scripts/fleetroom-check.js).
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/wsdelete-check.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { call, createRoom, registerAndLogin, loginPage, openWorkspace, openSettings, uniqUser } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let step = 'setup';
let failPage = null;
const shot = (page, name) => page.screenshot({ path: path.join(OUT, 'wsdelete-' + name) });
const hiddenNow = (page, sel) => page.$eval(sel, (el) => el.classList.contains('hidden'));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];
  const page = await browser.newPage();
  failPage = page;
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

  // A owns "keep" and "gone"; B enters "gone" and is made admin; an agent joins "gone"
  const session = await loginPage(page, SERVER, uniqUser(), { displayName: 'Ona Owner' });
  const keep = await createRoom(SERVER, session, 'keep me');
  const gone = await createRoom(SERVER, session, 'gone soon');
  const sessionB = await registerAndLogin(SERVER, uniqUser(), 'Ada Admin');
  const entered = await call(SERVER, '/api/v1/workspaces/' + gone.room.slug + '/enter', { method: 'POST', token: sessionB, body: { invite_code: gone.invite_code } });
  await call(SERVER, '/api/v1/participants/' + entered.participant.id + '/role', { method: 'POST', token: session, headers: { 'X-Workspace-Slug': gone.room.slug }, body: { role: 'admin' } });
  const agent = await call(SERVER, '/api/v1/rooms/join', { method: 'POST', body: { invite_code: gone.invite_code, name: 'gonebot', description: 'an agent in the doomed room' } });
  await call(SERVER, '/api/v1/me', { token: agent.token });

  step = '1';
  // 1. the non-owner admin: workspace settings without a Danger zone
  // own context: B's session must not share A's localStorage
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  pageB.on('pageerror', (e) => errors.push('pageerror B: ' + e.message));
  await openWorkspace(pageB, SERVER, sessionB, gone.room.slug);
  await openSettings(pageB, SERVER, 'workspace');
  await pageB.waitForSelector('#ws-invite:not(.hidden)', { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 500));
  assert(await hiddenNow(pageB, '#ws-danger'), 'non-owner admin sees the Danger zone');
  await shot(pageB, 'admin.png');
  // B keeps a tab open on the doomed room; it must route itself home after the delete
  await openWorkspace(pageB, SERVER, sessionB, gone.room.slug);

  step = '2';
  // 2. the owner: Danger zone shown, the button armed only by the exact name
  await openWorkspace(page, SERVER, session, gone.room.slug);
  await openSettings(page, SERVER, 'workspace');
  await page.waitForSelector('#ws-danger:not(.hidden)', { timeout: 8000 });
  assert(await page.$eval('#ws-delete', (b) => b.disabled), 'button armed before typing');
  await page.type('#ws-delete-name', 'gone soo');
  assert(await page.$eval('#ws-delete', (b) => b.disabled), 'button armed by a partial name');
  await page.type('#ws-delete-name', 'n');
  assert(!await page.$eval('#ws-delete', (b) => b.disabled), 'button not armed by the exact name');
  await shot(page, 'armed.png');

  step = '3';
  // 3. confirm once (not the fleet room), land on the remaining workspace
  // no networkidle wait: the chat view's long poll never goes idle
  await page.click('#ws-delete');
  await page.waitForFunction((s) => location.pathname.startsWith('/w/' + s), { timeout: 20000 }, keep.room.slug);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  assert(dialogs.length === 1 && dialogs[0].includes('gone soon'), 'confirms: ' + JSON.stringify(dialogs));
  await page.waitForFunction(() => document.querySelectorAll('#rail-list .rail-item').length === 1, { timeout: 8000 });
  await shot(page, 'after.png');
  // the stale tab learns on its next poll: the long poll runs up to 25 s
  await pageB.waitForFunction(() => !location.pathname.startsWith('/w/'), { timeout: 40000 });
  await shot(pageB, 'admin-after.png');
  await pageB.close();

  step = '4';
  // 4. the deleted room is gone for its agent and its members
  const me = await fetch(SERVER + '/api/v1/me', { headers: { Authorization: 'Bearer ' + agent.token } });
  assert(me.status === 401, 'agent token after delete: ' + me.status);
  const userB = await call(SERVER, '/api/v1/user', { token: sessionB });
  assert(!(userB.workspaces || []).some((w) => w.slug === gone.room.slug), 'B still lists the deleted room');

  await browser.close();
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  console.log('WSDELETE_CHECK_OK');
})().catch(async (e) => {
  console.error('FAIL at step ' + step + ': ' + e.message);
  try {
    if (failPage) {
      console.error('url=' + failPage.url() + ' err=' + await failPage.$eval('#ws-delete-error', (el) => el.textContent).catch(() => '-'));
      await failPage.screenshot({ path: path.join(OUT, 'wsdelete-fail.png') });
    }
  } catch (_) { /* best effort */ }
  process.exit(1);
});
