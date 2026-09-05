// E2E for invite links (task 17): the admin's link opens /join/<token>. Logged
// out, the page sends the visitor to /login with a "You were invited to" hint;
// logged in, it enters the workspace and lands on /w/<slug>. A revoked link and
// an expired link show the dead-link card instead. Screenshots land in OUT.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/invitelink-check.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs, call, registerAndLogin, uniqUser, sleep } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const tokenOf = (link) => link.split('/join/')[1];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const room = await newRoom(SERVER, 'invite link check');
  const slug = room.room.slug;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const admin = await browser.newPage();
  await admin.setViewport({ width: 1280, height: 800 });
  const adminSession = await enterAs(admin, SERVER, slug, room.invite, 'Alice');
  const mint = (body) => call(SERVER, '/api/v1/invites', { method: 'POST', token: adminSession, headers: { 'X-Workspace-Slug': slug }, body });
  const minted = await mint({ max_uses: 5 });
  const link = minted.join_url;
  assert(link.startsWith(SERVER + '/join/inv-'), 'minted link: ' + link);

  // 1. logged out: /join/<token> bounces to /login and names the workspace
  const ctx = await browser.createBrowserContext();
  const guest = await ctx.newPage();
  await guest.setViewport({ width: 1280, height: 800 });
  await guest.goto(link, { waitUntil: 'networkidle2' });
  await guest.waitForFunction(() => location.pathname === '/login', { timeout: 8000 });
  await guest.waitForSelector('#login-invite:not(.hidden)', { timeout: 8000 });
  const hint = await guest.$eval('#login-invite', (el) => el.textContent);
  assert(hint.includes('invite link check'), 'login hint: ' + hint);
  await guest.screenshot({ path: path.join(OUT, 'join-login-hint.png') });
  assert((await guest.$eval('#login-register-link', (a) => a.getAttribute('href'))).includes('next=%2Fjoin%2F'), 'register link lost ?next');
  await guest.click('#login-register-link');
  await guest.waitForSelector('#register-invite:not(.hidden)', { timeout: 8000 });
  assert((await guest.$eval('#register-invite', (el) => el.textContent)).includes('invite link check'), 'register hint');

  // 2. logged in: the same link enters and lands in the workspace
  const session = await registerAndLogin(SERVER, uniqUser(), 'Guest Gale');
  await guest.evaluate((t) => localStorage.setItem('agentchat:session', t), session);
  await guest.goto(link, { waitUntil: 'networkidle2' });
  await guest.waitForFunction((p) => location.pathname === p || location.pathname.startsWith(p + '/'), { timeout: 8000 }, '/w/' + slug);
  await guest.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await guest.waitForFunction(() => document.querySelector('#participant-list').textContent.includes('Guest Gale'), { timeout: 8000 });
  await guest.screenshot({ path: path.join(OUT, 'join-landed.png') });
  const after = await call(SERVER, '/api/v1/invites', { token: adminSession, headers: { 'X-Workspace-Slug': slug } });
  const row = after.invites.find((v) => v.id === minted.invite.id);
  assert(row && row.uses === 1 && row.status === 'active', 'uses after one join: ' + JSON.stringify(row));
  // a member re-opening their own link is a no-op that spends nothing
  await guest.goto(link, { waitUntil: 'networkidle2' });
  await guest.waitForFunction((p) => location.pathname === p || location.pathname.startsWith(p + '/'), { timeout: 8000 }, '/w/' + slug);
  const again = (await call(SERVER, '/api/v1/invites', { token: adminSession, headers: { 'X-Workspace-Slug': slug } })).invites.find((v) => v.id === minted.invite.id);
  assert(again.uses === 1, 'a member re-entering spent a use: ' + JSON.stringify(again));

  // 3. revoked: the dead-link card, with a way home
  await call(SERVER, '/api/v1/invites/' + minted.invite.id, { method: 'DELETE', token: adminSession, headers: { 'X-Workspace-Slug': slug } });
  const late = await browser.createBrowserContext().then((c) => c.newPage());
  await late.setViewport({ width: 1280, height: 800 });
  await late.goto(link, { waitUntil: 'networkidle2' });
  await late.waitForSelector('#join-view:not(.hidden)', { timeout: 8000 });
  const dead = await late.evaluate(() => ({ title: document.getElementById('join-title').textContent, msg: document.getElementById('join-msg').textContent, home: !document.getElementById('join-home').classList.contains('hidden') }));
  assert(/no longer works/.test(dead.title) && /revoked/.test(dead.msg) && dead.home, 'dead card: ' + JSON.stringify(dead));
  assert(await late.evaluate(() => getComputedStyle(document.getElementById('splash')).display === 'none'), 'splash still covers the dead-link card');
  await late.screenshot({ path: path.join(OUT, 'join-revoked.png') });

  // 4. expired: same card, the expiry reason
  const brief = await mint({ expires_in_seconds: 1 });
  await sleep(1500);
  await late.goto(brief.join_url, { waitUntil: 'networkidle2' });
  await late.waitForSelector('#join-view:not(.hidden)', { timeout: 8000 });
  const exp = await late.$eval('#join-msg', (el) => el.textContent);
  assert(/expired/.test(exp), 'expired card: ' + exp);
  // and an unknown token
  await late.goto(SERVER + '/join/inv-0000-0000-0000-0000', { waitUntil: 'networkidle2' });
  await late.waitForFunction(() => /no longer works/.test(document.getElementById('join-title').textContent), { timeout: 8000 });

  // 5. the workspace link the room was created with still enters (the bare token path)
  assert(tokenOf(room.invite) === room.invite_code, 'invite_code is not the link token');

  await browser.close();
  console.log('INVITELINK_CHECK_OK');
})().catch((e) => { console.error('INVITELINK_CHECK_FAIL:', e.message); process.exit(1); });
