// E2E for "Invite member" in the workspace menu (tasks 10, 17). An admin opens
// the menu, clicks Invite member, and the modal lists the workspace's invite
// links: Copy copies the link, New link mints one, Revoke kills one. The copied
// link lets a second user in. A member has no Invite member item, and the old
// header buttons (copy invite, invite agent) are gone.
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
  const old = await page.evaluate(() => ['copy-link', 'invite-agent', 'invite-code', 'invite-code-copy'].filter((id) => document.getElementById(id)));
  assert(old.length === 0, 'old invite buttons still exist: ' + JSON.stringify(old));
};
const links = (page) => page.$$eval('#invite-list .invite-item input', (els) => els.map((e) => e.value));
const rows = (page) => page.$$eval('#invite-list .invite-item', (els) => els.map((e) => e.querySelector('.invite-meta').textContent));

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
  page.on('dialog', (d) => d.accept());
  await enterAs(page, SERVER, slug, room.invite, 'Alice');
  await noOldButtons(page);

  // 1. admin: menu > Invite member lists the workspace link; Copy copies it
  await openInviteModal(page);
  await page.waitForSelector('#invite-list .invite-item', { timeout: 8000 });
  assert((await links(page)).join() === room.invite, 'modal links: ' + (await links(page)).join());
  assert(/workspace link/.test((await rows(page))[0]), 'meta: ' + (await rows(page))[0]);
  await page.screenshot({ path: OUT + '/invite-modal.png' });
  await stubClipboard(page);
  await page.click('#invite-list .invite-copy');
  await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
  const copied = await page.evaluate(() => window.__copied);
  assert(copied === room.invite, 'copied text is not the link: ' + copied);

  // 2. New link with a 1-use cap, then Revoke it: the list follows
  await page.select('#invite-max', '1');
  await page.click('#invite-new-submit');
  await page.waitForFunction(() => document.querySelectorAll('#invite-list .invite-item').length === 2, { timeout: 8000 });
  const [, minted] = await links(page);
  assert(/\/join\/inv-/.test(minted) && minted !== room.invite, 'minted link: ' + minted);
  assert(/by Alice/.test((await rows(page))[1]) && /0\/1 uses/.test((await rows(page))[1]), 'minted meta: ' + (await rows(page))[1]);
  await page.screenshot({ path: OUT + '/invite-modal-two.png' });
  await page.$$eval('#invite-list .invite-revoke', (els) => els[1].click());
  await page.waitForFunction(() => document.querySelectorAll('#invite-list .invite-item').length === 1, { timeout: 8000 });
  assert((await links(page)).join() === room.invite, 'revoke removed the wrong row');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#invite-modal.hidden', { timeout: 5000 });

  // 3. a second user enters with the copied link, and sees no Invite member item
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
  // the workspace link counted Alice and Bob
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await openInviteModal(page);
  await page.waitForSelector('#invite-list .invite-item', { timeout: 8000 });
  assert(/2 uses/.test((await rows(page))[0]), 'uses did not count: ' + (await rows(page))[0]);

  await browser.close();
  console.log('INVITEMENU_CHECK_OK');
})().catch((e) => { console.error('INVITEMENU_CHECK_FAIL:', e.message); process.exit(1); });
