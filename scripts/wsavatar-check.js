// E2E for workspace avatars (task 11): a fresh workspace shows its initials on
// its colour slot in the switcher, the menu, the enter page and Workspace
// settings; an admin uploads a logo there and every place switches to the
// image (a member too, read-only); Remove brings the initials back.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/wsavatar-check.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const puppeteer = require('puppeteer-core');
const { call, createRoom, newRoom, enterAs, loginPage, openSettings, backToRoom, uniqUser } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let lastStep = 'start';
const visible = (page, sel) => { lastStep = 'wait ' + sel; return page.waitForSelector(sel + ':not(.hidden)', { timeout: 8000 }); };
const shot = async (page, name) => { lastStep = 'shot ' + name; await page.screenshot({ path: path.join(OUT, 'wsavatar-' + name) }); };
const mark = (page, sel) => page.$eval(sel + ' .ws-avatar', (el) => ({ initials: el.dataset.initials, hue: el.style.getPropertyValue('--ws-h'), img: el.classList.contains('has-img') && !!el.querySelector('img[src^="blob:"]') }));
const waitMark = (page, sel, img) => { lastStep = 'wait mark ' + sel + ' img=' + img; return page.waitForFunction((s, want) => { const el = document.querySelector(s + ' .ws-avatar'); return !!el && (el.classList.contains('has-img') && !!el.querySelector('img[src^="blob:"]')) === want; }, { timeout: 8000 }, sel, img); };
const openMenu = async (page) => { await visible(page, '#ws-switcher-wrap'); await page.evaluate(() => document.getElementById('ws-switcher').click()); await visible(page, '#ws-menu'); };

// a 48x48 solid orange png, so the logo reads in the screenshots
const png = () => {
  const w = 300, h = 300, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([230, 120, 20], y * (w * 3 + 1) + 1 + x * 3); }
  const crc = (b) => { let c = -1; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const logo = path.join(OUT, 'wsavatar-logo.png');
  fs.writeFileSync(logo, png());
  const origBytes = fs.statSync(logo).size;
  const room = await newRoom(SERVER, 'avatar check');
  const slug = room.room.slug;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];
  const newPage = async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    return page;
  };
  const admin = await newPage();
  const adminSession = await enterAs(admin, SERVER, slug, room.invite_code, 'Alice');
  const info = await call(SERVER, '/api/v1/room', { token: adminSession, headers: { 'X-Workspace-Slug': slug } });
  const hue = String(info.room.color * 30);
  assert(info.room.color >= 0 && info.room.color < 12 && !info.room.avatar_url, 'fresh room: ' + JSON.stringify(info.room));

  // 1. initials "AC" on the colour slot: switcher, and the menu rows (a second workspace too)
  const other = await createRoom(SERVER, adminSession, 'zed workspace');
  await admin.goto(SERVER + '/w/' + slug, { waitUntil: 'networkidle2' });
  await visible(admin, '#ws-switcher-wrap');
  await waitMark(admin, '#rail-list .rail-item[aria-current]', false);
  let m = await mark(admin, '#rail-list .rail-item[aria-current]');
  assert(m.initials === 'AC' && m.hue === hue, 'switcher mark: ' + JSON.stringify(m));
  assert(await admin.$eval('#ws-current', (el) => el.textContent) === 'avatar check', 'switcher name changed');
  // the header menu lists no workspaces; the other workspace's mark is in the rail
  await openMenu(admin);
  assert(!(await admin.$('#ws-menu .ws-avatar')), 'header menu still carries workspace marks');
  await admin.keyboard.press('Escape');
  m = await mark(admin, '#rail-list a.rail-item[href="/w/' + other.room.slug + '"]');
  assert(m.initials === 'ZW' && m.hue === String(other.room.color * 30), 'other workspace mark: ' + JSON.stringify(m));
  await shot(admin, 'before.png');

  // 2. the enter page peeks the colour and initials (no image before membership)
  const guest = await newPage();
  await loginPage(guest, SERVER, uniqUser(), { displayName: 'Gus Guest' });
  await guest.goto(SERVER + '/w/' + slug, { waitUntil: 'networkidle2' });
  await visible(guest, '#enter-view');
  await guest.waitForSelector('#enter-room-icon .ws-avatar', { timeout: 8000 });
  m = await mark(guest, '#enter-room-icon');
  assert(m.initials === 'AC' && m.hue === hue && !m.img, 'enter mark: ' + JSON.stringify(m));
  await shot(guest, 'enter.png');

  // 3. Workspace settings as admin: initials, upload controls, no Remove yet; upload the logo
  await openSettings(admin, SERVER, 'workspace');
  await visible(admin, '#ws-panel');
  await visible(admin, '#ws-avatar-actions');
  m = await mark(admin, '#ws-avatar-slot');
  assert(m.initials === 'AC' && m.hue === hue && !m.img, 'settings mark: ' + JSON.stringify(m));
  assert(await admin.$eval('#ws-avatar-remove', (el) => el.classList.contains('hidden')), 'Remove shown before an upload');
  await shot(admin, 'settings-before.png');
  const input = await admin.$('#ws-avatar-input');
  await input.uploadFile(logo);
  await waitMark(admin, '#ws-avatar-slot', true);
  await visible(admin, '#ws-avatar-remove');
  await shot(admin, 'settings-after.png');
  const after = await call(SERVER, '/api/v1/room', { token: adminSession, headers: { 'X-Workspace-Slug': slug } });
  assert(after.room.avatar_url && after.room.avatar_url.startsWith('/api/v1/attachments/'), 'avatar_url after upload: ' + JSON.stringify(after.room));

  // 3b. the chrome loads the resized copies, never the upload: the 96px
  // settings mark took ?size=512, smaller than the original
  const attURL = after.room.avatar_url;
  const entries = (page) => page.evaluate((u) => performance.getEntriesByType('resource').filter((e) => e.name.includes(u)).map((e) => ({ q: new URL(e.name).search, bytes: e.transferSize, enc: e.encodedBodySize })), attURL);
  let loads = await entries(admin);
  lastStep = 'settings loads ' + JSON.stringify(loads);
  assert(loads.some((e) => e.q === '?size=512') && !loads.some((e) => e.q === ''), 'settings mark: ' + JSON.stringify(loads));
  assert(loads.every((e) => e.enc > 0 && e.enc < origBytes), 'variant not smaller than the upload (' + origBytes + '): ' + JSON.stringify(loads));

  // 4. back in the room: the switcher and the menu show the image, from the
  // ?size=128 copy; a reload serves it from the browser cache (no bytes moved)
  await backToRoom(admin);
  await waitMark(admin, '#rail-list .rail-item[aria-current]', true);
  await shot(admin, 'after.png');
  loads = await entries(admin);
  lastStep = 'rail loads ' + JSON.stringify(loads);
  assert(loads.some((e) => e.q === '?size=128') && !loads.some((e) => e.q === ''), 'rail mark: ' + JSON.stringify(loads));
  assert(loads.every((e) => e.enc > 0 && e.enc < origBytes), 'variant not smaller than the upload (' + origBytes + '): ' + JSON.stringify(loads));
  await admin.reload({ waitUntil: 'domcontentloaded' });
  await waitMark(admin, '#rail-list .rail-item[aria-current]', true);
  loads = await entries(admin);
  lastStep = 'reload loads ' + JSON.stringify(loads);
  assert(loads.length && loads.every((e) => e.bytes === 0), 'reload refetched the mark: ' + JSON.stringify(loads));

  // 5. a member sees the image too, and Workspace settings shows it read-only
  const member = await newPage();
  await enterAs(member, SERVER, slug, room.invite_code, 'Bob');
  await waitMark(member, '#rail-list .rail-item[aria-current]', true);
  await openSettings(member, SERVER, 'workspace');
  await visible(member, '#ws-panel');
  await waitMark(member, '#ws-avatar-slot', true);
  assert(await member.$eval('#ws-avatar-actions', (el) => el.classList.contains('hidden')), 'member sees the upload controls');
  await shot(member, 'member-settings.png');

  // 6. Remove: initials come back, same colour
  await openSettings(admin, SERVER, 'workspace');
  await visible(admin, '#ws-avatar-remove');
  await admin.click('#ws-avatar-remove');
  await waitMark(admin, '#ws-avatar-slot', false);
  m = await mark(admin, '#ws-avatar-slot');
  assert(m.initials === 'AC' && m.hue === hue, 'mark after remove: ' + JSON.stringify(m));
  assert(await admin.$eval('#ws-avatar-remove', (el) => el.classList.contains('hidden')), 'Remove still shown after the remove');
  await backToRoom(admin);
  await waitMark(admin, '#rail-list .rail-item[aria-current]', false);
  await shot(admin, 'removed.png');

  const real = errors.filter((e) => !e.includes('favicon') && !/status of 403/.test(e));
  assert(!real.length, 'page errors: ' + real.join(' | '));
  console.log('WSAVATAR_CHECK_OK');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('WSAVATAR_CHECK_FAIL:', e.message, '(after: ' + lastStep + ')'); process.exit(1); });
