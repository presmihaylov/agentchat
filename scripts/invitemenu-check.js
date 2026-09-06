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
  const old = await page.evaluate(() => ['copy-link', 'invite-agent', 'invite-code', 'invite-code-copy', 'invite-agent-copy'].filter((id) => document.getElementById(id)));
  assert(old.length === 0, 'old invite buttons still exist: ' + JSON.stringify(old));
};
const links = (page) => page.$$eval('#invite-list .invite-item', (els) => els.map((e) => e.dataset.url));
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
  // shape: create row first, then the list; short token, icon actions revealed on hover, no raw inputs
  const shape = await page.evaluate(() => {
    const form = document.getElementById('invite-new'), list = document.getElementById('invite-list');
    const li = list.querySelector('.invite-item');
    const actions = li.querySelector('.invite-actions');
    return {
      formFirst: !!(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING),
      token: li.querySelector('.invite-token').textContent,
      copyIcon: !!li.querySelector('.invite-copy svg[data-icon="copy"]'),
      revokeIcon: !!li.querySelector('.invite-revoke svg[data-icon="trash-2"]'),
      inputs: list.querySelectorAll('input').length,
      restOpacity: getComputedStyle(actions).opacity,
      emptyHidden: document.getElementById('invite-empty').classList.contains('hidden'),
      width: document.getElementById('invite-card').getBoundingClientRect().width,
      submitFocused: document.activeElement === document.getElementById('invite-new-submit'),
    };
  });
  assert(shape.formFirst, 'create row is not above the list');
  assert(/^inv-\w{4}…$/.test(shape.token), 'short token: ' + shape.token);
  assert(shape.copyIcon && shape.revokeIcon && shape.inputs === 0, 'row actions: ' + JSON.stringify(shape));
  assert(shape.restOpacity === '0', 'actions visible at rest: ' + shape.restOpacity);
  assert(shape.emptyHidden, 'empty state shows with rows present');
  assert(shape.width >= 600 && shape.width <= 720, 'modal width: ' + shape.width);
  assert(shape.submitFocused, 'Create link is not focused on open');
  await page.hover('#invite-list .invite-item');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#invite-list .invite-actions')).opacity === '1', { timeout: 3000 });
  await page.screenshot({ path: OUT + '/invite-modal.png' });
  await stubClipboard(page);
  await page.click('#invite-list .invite-copy');
  await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
  const copied = await page.evaluate(() => window.__copied);
  assert(copied === room.invite, 'copied text is not the link: ' + copied);

  // 2. New link, then Revoke it: the list follows. The modal offers an expiry
  // only; the use cap is gone.
  assert(!(await page.$('#invite-max')), 'Max uses select still in the invite modal');
  await page.click('#invite-new-submit');
  await page.waitForFunction(() => document.querySelectorAll('#invite-list .invite-item').length === 2, { timeout: 8000 });
  // newest first
  const [minted] = await links(page);
  assert(/\/join\/inv-/.test(minted) && minted !== room.invite, 'minted link: ' + minted);
  assert(/by Alice/.test((await rows(page))[0]) && /0 uses/.test((await rows(page))[0]), 'minted meta: ' + (await rows(page))[0]);
  await page.screenshot({ path: OUT + '/invite-modal-two.png' });
  await page.$$eval('#invite-list .invite-revoke', (els) => els[0].click());
  await page.waitForFunction(() => document.querySelectorAll('#invite-list .invite-item').length === 1, { timeout: 8000 });
  assert((await links(page)).join() === room.invite, 'revoke removed the wrong row');
  // the footer link hands over to Add an agent instead of duplicating it
  await page.click('#invite-open-addagent');
  await page.waitForSelector('#addagent-modal:not(.hidden)', { timeout: 5000 });
  assert(await page.$('#invite-modal.hidden'), 'invite modal stayed open behind Add an agent');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#addagent-modal.hidden', { timeout: 5000 });

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
  const wsRow = await page.$$eval('#invite-list .invite-item', (els, u) => (els.find((e) => e.dataset.url === u) || {}).textContent, room.invite);
  assert(/2 uses/.test(wsRow), 'uses did not count: ' + wsRow);

  await browser.close();
  console.log('INVITEMENU_CHECK_OK');
})().catch((e) => { console.error('INVITEMENU_CHECK_FAIL:', e.message); process.exit(1); });
