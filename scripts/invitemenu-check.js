// E2E for "Invite member" in the workspace menu (task 10). An admin opens the
// menu, clicks Invite member, and the modal shows the join link and the invite
// code; the copied code lets a second user in. A member has no Invite member
// item, and the old header buttons (copy invite, invite agent) are gone.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/invitemenu-check.js
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs, openInviteModal } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const stubClipboard = (page) => page.evaluate(() => {
  window.__copied = null;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true });
});
const noOldButtons = async (page) => {
  const old = await page.evaluate(() => ['copy-link', 'invite-agent'].filter((id) => document.getElementById(id)));
  assert(old.length === 0, 'old header buttons still exist: ' + JSON.stringify(old));
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const room = await newRoom(SERVER, 'invite menu check');
  const slug = room.room.slug;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await enterAs(page, SERVER, slug, room.invite_code, 'Alice');
  await noOldButtons(page);

  // 1. admin: menu > Invite member shows the link and the code
  await openInviteModal(page);
  const shown = await page.evaluate(() => ({ link: document.getElementById('invite-link').value, code: document.getElementById('invite-code').value }));
  assert(shown.link === room.join_url, 'modal link: ' + shown.link + ' vs ' + room.join_url);
  assert(shown.code === room.invite_code, 'modal code: ' + shown.code);
  await page.screenshot({ path: OUT + '/invite-modal.png' });
  await stubClipboard(page);
  await page.click('#invite-code-copy');
  await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
  const copied = await page.evaluate(() => window.__copied);
  assert(copied.includes(room.invite_code), 'copied text lacks the code: ' + copied);
  await page.click('#invite-link-copy');
  await page.waitForFunction(() => /invite code/.test(window.__copied || ''), { timeout: 5000 });
  const copiedLink = await page.evaluate(() => window.__copied);
  assert(copiedLink.startsWith(room.join_url) && copiedLink.includes(room.invite_code), 'copied link lacks link+code: ' + copiedLink);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#invite-modal.hidden', { timeout: 5000 });

  // 2. a second user enters with the copied code, and sees no Invite member item
  const ctx = await browser.createBrowserContext();
  const bob = await ctx.newPage();
  await bob.setViewport({ width: 1280, height: 800 });
  await enterAs(bob, SERVER, slug, copied.trim(), 'Bob');
  await noOldButtons(bob);
  await bob.waitForSelector('#ws-switcher-wrap:not(.hidden)', { timeout: 8000 });
  await bob.click('#ws-switcher');
  await bob.waitForSelector('#ws-menu:not(.hidden)', { timeout: 5000 });
  const items = await bob.$$eval('#ws-menu .ws-item', (els) => els.map((e) => e.textContent.trim()));
  assert(!items.includes('Invite member'), 'member sees Invite member: ' + JSON.stringify(items));
  assert(!items.includes('Create workspace') && items.includes('Settings'), 'member menu: ' + JSON.stringify(items));
  assert(!(await bob.$('#ws-invite-member')), 'member has the invite item in the DOM');

  await browser.close();
  console.log('INVITEMENU_CHECK_OK');
})().catch((e) => { console.error('INVITEMENU_CHECK_FAIL:', e.message); process.exit(1); });
