// E2E for kick members (task 15). An admin opens the Members section of
// workspace settings, removes an agent and a human, both rows go, the human's
// next load of the room shows the removed notice, and the owner row (and the
// admin's own row) carry no Remove button.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/kick-check.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { call, createRoom, registerAndLogin, loginPage, openWorkspace, openSettings, uniqUser } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let step = 'setup';
let failPage = null;
const shot = (page, name) => page.screenshot({ path: path.join(OUT, 'kick-' + name) });
const rows = (page) => page.$$eval('#ws-member-list li', (els) => els.map((li) => ({
  id: li.dataset.id, name: li.querySelector('.member-name').textContent, role: li.querySelector('.member-role').textContent,
  sub: li.querySelector('.member-sub').textContent, remove: !!li.querySelector('.member-remove'),
})));

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
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

  // the owner creates the room; an admin (page), a plain human and an agent enter
  const ownerSession = await registerAndLogin(SERVER, uniqUser(), 'Ona Owner');
  const made = await createRoom(SERVER, ownerSession, 'crew');
  const slug = made.room.slug;
  const adminSession = await loginPage(page, SERVER, uniqUser(), { displayName: 'Ada Admin' });
  const adminEntered = await call(SERVER, '/api/v1/workspaces/' + slug + '/enter', { method: 'POST', token: adminSession, body: { invite_code: made.invite_code } });
  await call(SERVER, '/api/v1/participants/' + adminEntered.participant.id + '/role', { method: 'POST', token: ownerSession, headers: { 'X-Workspace-Slug': slug }, body: { role: 'admin' } });
  const humanSession = await registerAndLogin(SERVER, uniqUser(), 'Hal Human');
  const humanEntered = await call(SERVER, '/api/v1/workspaces/' + slug + '/enter', { method: 'POST', token: humanSession, body: { invite_code: made.invite_code } });
  const agent = await call(SERVER, '/api/v1/rooms/join', { method: 'POST', body: { invite_code: made.invite_code, name: 'crewbot', description: 'an agent about to go' } });
  await call(SERVER, '/api/v1/me', { token: agent.token });

  // the human has the room open in its own context; it must see the removed notice on the next load
  const ctxH = await browser.createBrowserContext();
  const pageH = await ctxH.newPage();
  pageH.on('pageerror', (e) => errors.push('pageerror H: ' + e.message));
  await openWorkspace(pageH, SERVER, humanSession, slug);
  await pageH.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  step = '1';
  // 1. the admin's Members section: four rows, owner and self without Remove
  await openWorkspace(page, SERVER, adminSession, slug);
  await openSettings(page, SERVER, 'workspace');
  await page.waitForSelector('#ws-members:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('#ws-member-list li').length === 4, { timeout: 8000 });
  let list = await rows(page);
  const byName = (n) => list.find((r) => r.name === n);
  assert(byName('Ona Owner') && byName('Ona Owner').role === 'owner' && !byName('Ona Owner').remove, 'owner row: ' + JSON.stringify(byName('Ona Owner')));
  assert(byName('Ada Admin') && byName('Ada Admin').role === 'admin' && !byName('Ada Admin').remove, 'own row: ' + JSON.stringify(byName('Ada Admin')));
  assert(byName('Hal Human') && byName('Hal Human').remove && byName('Hal Human').sub.startsWith('@'), 'human row: ' + JSON.stringify(byName('Hal Human')));
  assert(byName('crewbot') && byName('crewbot').remove && byName('crewbot').sub.startsWith('agent'), 'agent row: ' + JSON.stringify(byName('crewbot')));
  await shot(page, 'members.png');

  step = '2';
  // 2. remove the agent, then the human: rows go, confirms were asked
  await page.click('#ws-member-list li[data-id="' + agent.participant.id + '"] .member-remove');
  await page.waitForFunction((id) => !document.querySelector('#ws-member-list li[data-id="' + id + '"]'), { timeout: 8000 }, agent.participant.id);
  await page.click('#ws-member-list li[data-id="' + humanEntered.participant.id + '"] .member-remove');
  await page.waitForFunction((id) => !document.querySelector('#ws-member-list li[data-id="' + id + '"]'), { timeout: 8000 }, humanEntered.participant.id);
  list = await rows(page);
  assert(list.length === 2 && dialogs.length === 2 && /crewbot \(agent/.test(dialogs[0]) && /Hal Human/.test(dialogs[1]), 'after removes: ' + JSON.stringify({ list, dialogs }));
  await shot(page, 'after.png');

  step = '3';
  // 3. the agent token is dead, the human sees the removed notice on the next load
  const me = await fetch(SERVER + '/api/v1/me', { headers: { Authorization: 'Bearer ' + agent.token } });
  assert(me.status === 401, 'agent token after remove: ' + me.status);
  await pageH.reload({ waitUntil: 'domcontentloaded' });
  await pageH.waitForSelector('#removed-view:not(.hidden)', { timeout: 8000 });
  await shot(pageH, 'removed.png');
  const userH = await call(SERVER, '/api/v1/user', { token: humanSession });
  assert(!(userH.workspaces || []).some((w) => w.slug === slug), 'kicked human still lists the workspace');

  step = '4';
  // 4. a plain member's settings carry no Members section
  const memberSession = await registerAndLogin(SERVER, uniqUser(), 'Mia Member');
  await call(SERVER, '/api/v1/workspaces/' + slug + '/enter', { method: 'POST', token: memberSession, body: { invite_code: made.invite_code } });
  const ctxM = await browser.createBrowserContext();
  const pageM = await ctxM.newPage();
  await openWorkspace(pageM, SERVER, memberSession, slug);
  await openSettings(pageM, SERVER, 'workspace');
  await pageM.waitForSelector('#ws-panel:not(.hidden)', { timeout: 8000 });
  await pageM.waitForFunction(() => document.getElementById('ws-name').value === 'crew', { timeout: 8000 });
  assert(await pageM.$eval('#ws-members', (el) => el.classList.contains('hidden')), 'member sees the Members section');

  await browser.close();
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  console.log('KICK_CHECK_OK');
})().catch(async (e) => {
  console.error('FAIL at step ' + step + ': ' + e.message);
  try { if (failPage) { console.error('url=' + failPage.url()); await failPage.screenshot({ path: path.join(OUT, 'kick-fail.png') }); } } catch (_) { /* best effort */ }
  process.exit(1);
});
