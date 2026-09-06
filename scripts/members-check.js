// E2E: channel-members modal (header 👥 count, grouped roster, add/remove) and
// the /remove slash command. The viewer joins first, so they are the admin.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/members-check.js
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { newRoom, openAsHuman } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';

async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await newRoom(SERVER, 'members check');
  const slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', avatar: '🧑', is_human: true } });
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'membot', description: 't' } });
  await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'team', topic: '' } });
  await api('/api/v1/channels/team/join', { method: 'POST', token: viewer.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
    await openAsHuman(page, SERVER, slug, viewer);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  // open #team; the header affordance shows the member count
  await page.evaluate(() => {
    [...document.querySelectorAll('#channel-list li')].find((li) => li.textContent.includes('team')).click();
  });
  await page.waitForFunction(() =>
    !document.querySelector('#members-btn').classList.contains('hidden')
    && document.querySelector('#members-count').textContent === '2', { timeout: 8000 })
    .catch(() => { throw new Error('header member count did not show 2'); });

  // the modal groups humans and agents, with online dots and admin remove buttons
  await page.evaluate(() => document.querySelector('#members-btn').click());
  await page.waitForFunction(() => !document.querySelector('#members-modal').classList.contains('hidden'), { timeout: 8000 });
  const modal = await page.evaluate(() => ({
    title: document.querySelector('#members-title').textContent,
    groups: [...document.querySelectorAll('#members-list .mm-group')].map((g) => g.textContent),
    rows: [...document.querySelectorAll('#members-list .mm-row')].map((r) => ({
      name: r.querySelector('.mm-name').textContent,
      online: r.querySelector('.mm-dot').classList.contains('on'),
      canRemove: !!r.querySelector('.mm-remove'),
    })),
  }));
  assert(modal.title.includes('team') && modal.title.includes('2'), 'modal title: ' + modal.title);
  assert(modal.groups.join() === 'Humans,Agents', 'groups: ' + modal.groups.join());
  const vRow = modal.rows.find((r) => r.name === 'viewer');
  const bRow = modal.rows.find((r) => r.name === 'membot');
  assert(vRow && bRow, 'rows: ' + JSON.stringify(modal.rows));
  assert(vRow.online, 'viewer should show online');
  assert(!vRow.canRemove && bRow.canRemove, 'remove buttons: self must have none, membot must');
  // Remove is the shared subtle .remove-btn (outline, muted, 13px/500, no icon), right-aligned at
  // one x on every row; my own row keeps an invisible .remove-gap of the same width (Maya, 06e9f192)
  const look = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width) }; };
    const btn = document.querySelector('#members-list .mm-remove');
    const cs = getComputedStyle(btn);
    const slots = [...document.querySelectorAll('#members-list .mm-remove, #members-list .mm-remove-gap')].map(box);
    const gap = document.querySelector('#members-list .mm-remove-gap');
    return {
      shared: btn.classList.contains('remove-btn'), bg: cs.backgroundColor, border: cs.borderWidth + ' ' + cs.borderStyle, font: cs.fontSize + '/' + cs.fontWeight, icon: !!btn.querySelector('svg'),
      slots, gapHidden: !!gap && getComputedStyle(gap).visibility === 'hidden' && gap.classList.contains('remove-gap'),
      rightGap: Math.round(btn.closest('.mm-row').getBoundingClientRect().right - btn.getBoundingClientRect().right),
    };
  });
  assert(look.shared && look.bg === 'rgba(0, 0, 0, 0)' && look.border === '1px solid' && look.font === '13px/500' && !look.icon, 'modal remove look: ' + JSON.stringify(look));
  assert(look.slots.length === 2 && look.slots.every((s) => s.x === look.slots[0].x && s.w === look.slots[0].w) && look.gapHidden && look.rightGap === 16, 'modal remove column: ' + JSON.stringify(look));
  if (process.env.OUT) { fs.mkdirSync(process.env.OUT, { recursive: true }); await page.screenshot({ path: process.env.OUT + '/members-modal.png' }); }

  // remove from the modal; the roster and header count follow
  await page.evaluate(() => {
    [...document.querySelectorAll('#members-list .mm-row')]
      .find((r) => r.querySelector('.mm-name').textContent === 'membot')
      .querySelector('.mm-remove').click();
  });
  await page.waitForFunction(() =>
    document.querySelectorAll('#members-list .mm-row').length === 1
    && document.querySelector('#members-count').textContent === '1', { timeout: 8000 })
    .catch(() => { throw new Error('modal remove did not shrink the roster'); });

  // add back from the modal's add list; the button reads "Add member" and a
  // programmatic focus (mouse click) draws no ring, only :focus-visible does
  await page.click('#members-invite'); // a real mouse click: focus without :focus-visible
  const inviteBtn = await page.evaluate(() => { const b = document.querySelector('#members-invite'); const cs = getComputedStyle(b); return { text: b.textContent.trim(), outline: cs.outlineStyle, focused: document.activeElement === b }; });
  if (inviteBtn.text !== 'Add member') throw new Error('members button reads "' + inviteBtn.text + '", want Add member');
  if (!inviteBtn.focused) throw new Error('Add member did not take focus on click');
  if (inviteBtn.outline !== 'none') throw new Error('Add member shows a ring after a mouse click: ' + inviteBtn.outline);
  await page.waitForFunction(() =>
    document.querySelectorAll('#members-addlist .mm-row').length === 1, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#members-addlist .mm-add').click());
  await page.waitForFunction(() =>
    document.querySelectorAll('#members-list .mm-row').length === 2, { timeout: 8000 })
    .catch(() => { throw new Error('modal add did not grow the roster'); });

  // Esc closes the modal
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#members-modal').classList.contains('hidden'), { timeout: 4000 });

  // /remove slash command from the composer
  await page.click('#composer-mount .ProseMirror');
  await page.keyboard.type('/remove membot', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document.querySelector('#composer .composer-status')?.textContent.includes('Removed membot'), { timeout: 8000 })
    .catch(() => { throw new Error('/remove gave no confirmation'); });
  await page.waitForFunction(() => document.querySelector('#members-count').textContent === '1', { timeout: 8000 })
    .catch(() => { throw new Error('/remove did not update the header count live'); });

  await browser.close();
  console.log('MEMBERS_CHECK_OK');
})().catch((e) => { console.error('MEMBERS_CHECK_FAIL:', e.message); process.exit(1); });
