// E2E for the one settings place (task 09): /settings has a Workspace tab and
// a Personal tab. An admin renames the workspace and regenerates the invite
// code; a member sees the Workspace tab read-only; Personal changes the
// password, the avatar and a notification pref; the profile modal carries no
// settings any more, and the room page has exactly two ways into /settings
// (the sidebar entry and the workspace menu item).
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/settings-check.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs, loginPage, enterWithCode, openSettings, backToRoom, PASSWORD, sleep } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || '.';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
async function api(p, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { Authorization: 'Bearer ' + opts.token } : {});
  if (opts.slug) headers['X-Workspace-Slug'] = opts.slug;
  const resp = await fetch(SERVER + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 429) { await sleep(3000); return api(p, opts); }
  if (resp.status >= 400) { const e = new Error(p + ' -> ' + resp.status + ' ' + JSON.stringify(data)); e.status = resp.status; throw e; }
  return data;
}
// a 1x1 png for the avatar upload
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const room = await newRoom(SERVER, 'settings check');
  const slug = room.room.slug;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('dialog', (d) => d.accept());
  const adminSession = await enterAs(page, SERVER, slug, room.invite_code, 'Alice');

  // 1. the room page has exactly two doors into settings: the sidebar entry and the menu item
  await page.waitForSelector('#ws-switcher-wrap:not(.hidden)', { timeout: 8000 });
  // the hidden password banner also links to /settings; it is not a door
  const doors = await page.$$eval('a[href^="/settings"]', (els) => els.filter((el) => !el.closest('#pw-banner')).map((el) => el.id || el.className));
  assert(doors.length === 2 && doors.includes('open-settings') && doors.includes('ws-item'), 'settings doors: ' + JSON.stringify(doors));
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#open-settings')]);
  await page.waitForSelector('#settings-view:not(.hidden)', { timeout: 8000 });
  assert(await page.$eval('#tab-personal', (el) => el.classList.contains('active')), 'Personal is the default tab');

  // 2. Workspace tab as admin: rename, and the sidebar follows
  await page.click('#tab-workspace');
  await page.waitForSelector('#ws-panel:not(.hidden)', { timeout: 8000 });
  assert(!(await page.$eval('#ws-name', (el) => el.disabled)), 'admin can edit the name');
  assert(await page.$eval('#ws-slug', (el) => el.value).then((v) => v.endsWith('/w/' + slug)), 'link shows the slug');
  await page.$eval('#ws-name', (el) => { el.value = ''; });
  await page.type('#ws-name', 'Renamed by settings');
  await page.click('#ws-name-save');
  await page.waitForSelector('#ws-name-ok:not(.hidden)', { timeout: 8000 });
  await page.screenshot({ path: path.join(OUT, 'settings-workspace.png') });
  await backToRoom(page);
  assert((await page.$eval('#ws-current', (el) => el.textContent)) === 'Renamed by settings', 'sidebar did not follow the rename');

  // 3. regenerate the invite: the old code is dead, the new one enters
  await openSettings(page, SERVER, 'workspace');
  await page.waitForSelector('#ws-invite:not(.hidden)', { timeout: 8000 });
  assert((await page.$eval('#ws-invite-code', (el) => el.value)) !== room.invite_code, 'code is masked until Show');
  await page.click('#ws-invite-show');
  assert((await page.$eval('#ws-invite-code', (el) => el.value)) === room.invite_code, 'Show reveals the code');
  await page.click('#ws-invite-regen');
  await page.waitForSelector('#ws-invite-ok:not(.hidden)', { timeout: 8000 });
  const newCode = await page.$eval('#ws-invite-code', (el) => el.value);
  assert(newCode && newCode !== room.invite_code, 'regenerate did not change the code');
  const bobCtx = await browser.createBrowserContext();
  const bob = await bobCtx.newPage();
  await loginPage(bob, SERVER, undefined, { displayName: 'Bob', next: '/r/' + slug });
  await bob.waitForSelector('#enter-view:not(.hidden)', { timeout: 8000 });
  await bob.type('#enter-code', room.invite_code);
  await bob.click('#enter-form button[type=submit]');
  await bob.waitForSelector('#enter-error:not(.hidden)', { timeout: 8000 });
  await enterWithCode(bob, newCode);

  // 4. a member sees the Workspace tab read-only
  await openSettings(bob, SERVER, 'workspace');
  await bob.waitForSelector('#ws-panel:not(.hidden)', { timeout: 8000 });
  assert(await bob.$eval('#ws-name', (el) => el.disabled), 'member must not edit the name');
  assert(await bob.$eval('#ws-name-save', (el) => el.classList.contains('hidden')), 'member has no Rename button');
  assert(await bob.$eval('#ws-invite', (el) => el.classList.contains('hidden')), 'member must not see the invite code');
  await bob.screenshot({ path: path.join(OUT, 'settings-workspace-member.png') });

  // 5. Personal: avatar upload and remove, a notification pref, the password
  await page.click('#tab-personal');
  await page.waitForSelector('#avatar-section:not(.hidden)', { timeout: 8000 });
  assert((await page.$eval('#avatar-ws-name', (el) => el.textContent)) === 'Renamed by settings', 'avatar section names the workspace');
  const tmp = path.join(os.tmpdir(), 'settings-check-avatar.png');
  fs.writeFileSync(tmp, PNG);
  const input = await page.$('#avatar-input');
  await input.uploadFile(tmp);
  await page.waitForSelector('#settings-avatar img', { timeout: 8000 });
  await page.waitForSelector('#avatar-remove:not(.hidden)', { timeout: 8000 });
  let me = await api('/api/v1/me', { token: adminSession, slug });
  assert(me.avatar_attachment_id, 'avatar not stored');
  await page.click('#avatar-remove');
  await page.waitForSelector('#settings-avatar .avatar-emoji', { timeout: 8000 });
  me = await api('/api/v1/me', { token: adminSession, slug });
  assert(!me.avatar_attachment_id, 'avatar not removed');
  await page.click('#notify-sound');
  await page.waitForFunction(() => !document.querySelector('#notify-sound').checked, { timeout: 5000 });
  await sleep(300);
  const prefs = await api('/api/v1/me/notifications', { token: adminSession, slug });
  assert(prefs.sound === false, 'sound pref not saved: ' + JSON.stringify(prefs));
  await page.screenshot({ path: path.join(OUT, 'settings-personal.png') });
  await page.type('#pw-current', PASSWORD);
  await page.type('#pw-new', 'a brand new passphrase');
  await page.type('#pw-confirm', 'a brand new passphrase');
  await page.click('#pw-form button[type=submit]');
  await page.waitForSelector('#pw-ok:not(.hidden)', { timeout: 8000 });

  // 6. the profile modal carries no settings any more
  await backToRoom(page);
  await page.click('#me-footer');
  await page.waitForSelector('#profile-modal:not(.hidden)', { timeout: 5000 });
  const leftovers = await page.$$eval('#profile-card #notify-settings, #profile-card #profile-actions, #profile-card select, #profile-card input', (els) => els.length);
  assert(leftovers === 0, 'profile modal still has settings controls: ' + leftovers);

  // 7. sign out from Personal lands on /login
  await openSettings(page, SERVER);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#settings-signout')]);
  assert(new URL(page.url()).pathname === '/login', 'sign out did not land on /login: ' + page.url());

  await browser.close();
  console.log('SETTINGS_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
