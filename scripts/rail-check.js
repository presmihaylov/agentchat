// E2E for the workspace rail (task 12): a user with three workspaces sees
// three round marks on the far left, the current one marked; a click on
// another switches in place to /w/<slug> (task 23); the "+" below the list (tooltip
// "Create workspace") opens a two-row menu, icon first then label; Create
// leads to /create, Join enters another workspace with its invite code in a
// modal. The #ws-menu action rows carry an icon before their label too, and
// the rail is absent on the account pages.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/rail-check.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { createRoom, registerAndLogin, loginPage, openWorkspace, switchTo, uniqUser } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let lastStep = 'start';
let step = 'setup';
const visible = (page, sel) => { lastStep = 'wait ' + sel; return page.waitForSelector(sel + ':not(.hidden)', { timeout: 8000 }); };
const hiddenNow = (page, sel) => page.$eval(sel, (el) => el.classList.contains('hidden'));
const shot = async (page, name) => { lastStep = 'shot ' + name; await page.screenshot({ path: path.join(OUT, 'rail-' + name) }); };
const atPath = (page, p) => { lastStep = 'wait for ' + p; return page.waitForFunction((x) => location.pathname === x || location.pathname.startsWith(x + '/'), { timeout: 8000 }, p); };
const railItems = (page) => page.$$eval('#rail-list .rail-item', (els) => els.map((a) => ({ href: a.getAttribute('href'), tip: a.dataset.tip, current: a.getAttribute('aria-current') === 'true', initials: a.querySelector('.ws-avatar') && a.querySelector('.ws-avatar').dataset.initials })));
// icon then label: the icon box sits left of the label box
const iconFirst = (page, sel) => page.$$eval(sel, (els) => els.map((el) => {
  const label = el.querySelector('.ws-label');
  const icon = el.querySelector('.mi-icon, .ws-avatar');
  const before = getComputedStyle(el, '::before').content;
  const iconLeft = icon ? icon.getBoundingClientRect().left : (before && before !== 'none' && before !== '""' ? el.getBoundingClientRect().left : null);
  const svg = icon && icon.querySelector('svg.lucide[data-icon]');
  return { text: (svg ? svg.dataset.icon + ':' : '') + el.textContent, hasIcon: iconLeft !== null, iconFirst: iconLeft !== null && label && iconLeft < label.getBoundingClientRect().left };
}));

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

  // A owns three workspaces; B owns a fourth that A joins through the rail later
  const session = await loginPage(page, SERVER, uniqUser(), { displayName: 'Ria Rail' });
  const one = await createRoom(SERVER, session, 'first place');
  const two = await createRoom(SERVER, session, 'second place');
  const three = await createRoom(SERVER, session, 'third place');
  const sessionB = await registerAndLogin(SERVER, uniqUser(), 'Bo Other');
  const four = await createRoom(SERVER, sessionB, 'fourth place');

  step = '1';
  // 1. three marks, the current one marked, tooltips carry the names
  await openWorkspace(page, SERVER, session, two.room.slug);
  await visible(page, '#ws-rail');
  await page.waitForFunction(() => document.querySelectorAll('#rail-list .rail-item').length === 3, { timeout: 8000 });
  let items = await railItems(page);
  assert(items.map((i) => i.href).join(',') === ['/w/' + one.room.slug, '/w/' + two.room.slug, '/w/' + three.room.slug].join(','), 'rail links: ' + JSON.stringify(items));
  assert(items.map((i) => i.current).join(',') === 'false,true,false', 'current mark: ' + JSON.stringify(items));
  assert(items.map((i) => i.tip).join('|') === 'first place|second place|third place', 'tooltips: ' + JSON.stringify(items));
  assert(items.map((i) => i.initials).join('') === 'FPSPTP', 'initials: ' + JSON.stringify(items));
  const geo = await page.evaluate(() => {
    const rail = document.querySelector('#ws-rail').getBoundingClientRect();
    const sb = document.querySelector('#sidebar').getBoundingClientRect();
    const avatars = [...document.querySelectorAll('#rail-list .ws-avatar')].map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, radius: getComputedStyle(el).borderRadius }; });
    return { railLeft: rail.left, railRight: rail.right, sbLeft: sb.left, avatars };
  });
  assert(geo.railLeft === 0 && geo.railRight <= geo.sbLeft, 'rail is not left of the sidebar: ' + JSON.stringify(geo));
  assert(geo.avatars.every((a) => a.w === 44 && a.h === 44), 'rail marks are not 44px: ' + JSON.stringify(geo.avatars));
  assert(geo.avatars[0].radius === '50%' && geo.avatars[1].radius === '14px', 'round others, squared current: ' + JSON.stringify(geo.avatars));
  // one sidebar type scale (task 20, Maya msg 6726d1bf): 11px caps headings, 14px rows, 14px/500 profile name
  const scale = await page.evaluate(() => {
    const f = (sel) => { const c = getComputedStyle(document.querySelector(sel)); return c.fontSize + '/' + c.fontWeight; };
    return { header: f('#ws-switcher'), h3: f('#sidebar h3'), row: f('#channel-list .chan-name'), me: f('.me-name') };
  });
  assert(scale.header === '15px/600' && scale.h3 === '11px/600' && scale.row === '14px/400' && scale.me === '14px/500', 'sidebar scale: ' + JSON.stringify(scale));
  // keyboard: the marks are links in order, then the "+"
  await page.focus('#rail-list .rail-item');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement.id) === 'rail-add', 'Tab order does not reach + after the marks');
  await page.evaluate(() => document.activeElement.blur());
  await new Promise((r) => setTimeout(r, 300)); // the focus transition on the + settles
  await shot(page, 'rail.png');

  step = '2';
  // 2. "+": tooltip "Create workspace" on hover, then the two-row menu, icon first
  const add = await page.$eval('#rail-add', (el) => ({ tip: el.dataset.tip, label: el.getAttribute('aria-label'), radius: getComputedStyle(el).borderRadius }));
  assert(add.tip === 'Create workspace' && add.label === 'Create workspace' && add.radius === '50%', 'the + button: ' + JSON.stringify(add));
  await page.hover('#rail-add');
  const tipShown = await page.$eval('#rail-add', (el) => getComputedStyle(el, '::after').content);
  assert(tipShown === '"Create workspace"', 'hover tooltip: ' + tipShown);
  await shot(page, 'add-hover.png');
  await page.click('#rail-add');
  await visible(page, '#rail-menu');
  assert(await page.$eval('#rail-add', (el) => el.getAttribute('aria-expanded')) === 'true', 'aria-expanded not true');
  const menuRows = await iconFirst(page, '#rail-menu .rail-menu-item');
  assert(menuRows.map((r) => r.text.replace(/\s+/g, ' ').trim()).join('|') === 'plus:Create workspace|log-in:Join with invite link', 'rail menu rows: ' + JSON.stringify(menuRows));
  assert(menuRows.every((r) => r.iconFirst), 'rail menu icon not first: ' + JSON.stringify(menuRows));
  assert(await page.$eval('#rail-create', (a) => a.getAttribute('href')).then((h) => h.startsWith('/create?next=')), 'Create row does not lead to /create');
  await shot(page, 'add-menu.png');
  // Escape closes and refocuses the "+"; a click outside closes too
  assert(await page.evaluate(() => document.activeElement.id) === 'rail-create', 'open did not focus the first row');
  await page.keyboard.press('ArrowDown');
  assert(await page.evaluate(() => document.activeElement.id) === 'rail-join', 'ArrowDown did not move to Join');
  await page.keyboard.press('ArrowDown');
  assert(await page.evaluate(() => document.activeElement.id) === 'rail-create', 'ArrowDown did not wrap');
  await page.keyboard.press('Escape');
  assert(await hiddenNow(page, '#rail-menu'), 'Escape did not close the rail menu');
  assert(await page.evaluate(() => document.activeElement.id) === 'rail-add', 'Escape did not refocus +');
  await page.click('#rail-add');
  await visible(page, '#rail-menu');
  await page.click('#messages');
  assert(await hiddenNow(page, '#rail-menu'), 'outside click did not close the rail menu');

  step = '3';
  // 3. the #ws-menu action rows: icon first, then the label, names unchanged
  await page.click('#ws-switcher');
  await visible(page, '#ws-menu');
  const wsRows = await iconFirst(page, '#ws-menu .ws-item');
  assert(wsRows.map((r) => r.text).join('|') === 'mail:Invite member|log-in:Join with invite link|settings:Settings', 'ws menu rows: ' + JSON.stringify(wsRows));
  assert(wsRows.every((r) => r.hasIcon && r.iconFirst), 'ws menu icon not first: ' + JSON.stringify(wsRows));
  await shot(page, 'ws-menu.png');
  await page.click('#ws-join');
  await visible(page, '#join-modal');
  assert(await hiddenNow(page, '#ws-menu'), 'ws menu stayed open behind the join modal');
  await page.keyboard.press('Escape');
  assert(await hiddenNow(page, '#join-modal'), 'Escape did not close the join modal from the ws menu');

  step = '4';
  // 4. a click on another mark switches in place to /w/<slug> (task 23), and the mark moves
  await switchTo(page, three.room.slug);
  await atPath(page, '/w/' + three.room.slug);
  await visible(page, '#ws-rail');
  await page.waitForFunction((s) => { const a = document.querySelector('#rail-list .rail-item[aria-current]'); return !!a && a.getAttribute('href') === '/w/' + s; }, { timeout: 8000 }, three.room.slug);
  await page.waitForFunction(() => document.querySelector('#ws-current').textContent === 'third place', { timeout: 8000 });

  step = '5';
  // 5. Create leads to /create; the rail is absent on the account pages
  await page.click('#rail-add');
  await visible(page, '#rail-menu');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }), page.click('#rail-create')]);
  await atPath(page, '/create');
  await visible(page, '#create-view');
  assert(await page.$eval('#ws-rail', (el) => getComputedStyle(el).display === 'none' || el.classList.contains('hidden')), 'rail shown on /create');
  // a fresh load, not goBack: the back-forward cache would restore the open menu
  await page.goto(SERVER + '/w/' + three.room.slug, { waitUntil: 'networkidle2' });
  await visible(page, '#ws-rail');

  step = '6';
  // 6. Join with invite link: a dead link lands on the join page's dead-link
  // card, the right one lands in B's workspace
  await page.click('#rail-add');
  await visible(page, '#rail-menu');
  await page.click('#rail-join');
  await visible(page, '#join-modal');
  assert(await hiddenNow(page, '#rail-menu'), 'rail menu stayed open behind the join modal');
  assert(await page.evaluate(() => document.activeElement.id) === 'join-link', 'join modal did not focus the link field');
  await page.type('#join-link', 'not a link');
  await page.click('#join-submit');
  await visible(page, '#join-error');
  await page.waitForFunction(() => /invite link/.test(document.querySelector('#join-error').textContent), { timeout: 8000 });
  await shot(page, 'join-error.png');
  await page.$eval('#join-link', (el) => { el.value = ''; });
  await page.type('#join-link', SERVER + '/join/inv-0000-0000-0000-0000');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }), page.click('#join-submit')]);
  await atPath(page, '/join/inv-0000-0000-0000-0000');
  await visible(page, '#join-view');
  await page.waitForFunction(() => /no longer works/.test(document.querySelector('#join-title').textContent), { timeout: 8000 });
  await shot(page, 'join-dead.png');
  await page.goto(SERVER + '/join/' + four.invite.split('/join/')[1], { waitUntil: 'networkidle2' });
  await page.waitForFunction((p) => location.pathname === p || location.pathname.startsWith(p + '/'), { timeout: 8000 }, '/w/' + four.room.slug);
  await shot(page, 'join.png');
  await atPath(page, '/w/' + four.room.slug);
  await visible(page, '#chat-view');
  await page.waitForFunction(() => document.querySelectorAll('#rail-list .rail-item').length === 4, { timeout: 8000 });
  items = await railItems(page);
  assert(items[3].href === '/w/' + four.room.slug && items[3].current, 'joined workspace not current in the rail: ' + JSON.stringify(items));
  await shot(page, 'joined.png');

  const real = errors.filter((e) => !e.includes('favicon') && !/status of (400|404)/.test(e));
  assert(!real.length, 'page errors: ' + real.join(' | '));
  console.log('RAIL_CHECK_OK');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('RAIL_CHECK_FAIL:', e.message, '(step ' + step + ', after: ' + lastStep + ')'); process.exit(1); });
