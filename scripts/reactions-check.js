require('fs').mkdirSync(process.env.OUT || 'tmp', { recursive: true });
// E2E for emoji reactions: the 😀 toolbar button opens a picker, a pick adds a
// pill under the message, clicking your own pill removes it, another
// participant's reaction lands live with a count and a "who" tooltip, the
// picker search finds :tada:, and the same pills show on the thread-panel copy.
// Run: NODE_PATH=<puppeteer dir> SERVER=http://localhost:8095 node scripts/reactions-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

(async () => {
  const created = await newRoom(SERVER, 'reactions check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'bob', description: 'bot' } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', body: { body: 'root by bob' }, token: bob.token });
  await api('/api/v1/channels/general/messages', { method: 'POST', body: { body: 'a reply', thread_root_id: root.id }, token: bob.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
    await openAsHuman(page, SERVER, slug, alice);
  const msgSel = `#messages .msg[data-id="${root.id}"]`;
  await page.waitForSelector(msgSel, { timeout: 8000 });

  const pills = (scope = '#messages') => page.$$eval(`${scope} .msg[data-id="${root.id}"] .msg-reactions .reaction:not(.add)`,
    (bs) => bs.map((b) => ({ emoji: b.dataset.emoji, count: b.querySelector('.rx-count').textContent, mine: b.classList.contains('mine'), title: b.dataset.names })));

  // 1. no reactions yet: the row is hidden
  assert((await pills()).length === 0, 'fresh message has pills');
  assert(await page.$eval(`${msgSel} .msg-reactions`, (b) => b.hidden), 'empty reaction row is visible');

  // 2. the 😀 toolbar button opens the picker; the quick row's first item is 👀
  await page.hover(msgSel);
  await page.click(`${msgSel} .msg-actions button[data-act="react"]`);
  await page.waitForSelector('.reaction-picker', { timeout: 4000 });
  const quick = await page.$$eval('.reaction-picker .rp-quick button', (bs) => bs.map((b) => b.textContent));
  assert(quick[0] === '👀' && quick[1] === '✅', 'quick row: ' + JSON.stringify(quick));
  await page.click('.reaction-picker .rp-quick button');
  await page.waitForFunction((sel) => document.querySelector(`${sel} .msg-reactions .reaction.mine`) !== null, { timeout: 4000 }, msgSel);
  assert(await page.$('.reaction-picker') === null, 'picker stayed open after a pick');
  let got = await pills();
  assert(got.length === 1 && got[0].emoji === '👀' && got[0].count === '1' && got[0].mine && got[0].title === 'alice', 'after 👀: ' + JSON.stringify(got));
  const onServer = (await api('/api/v1/messages/' + root.id, { token: alice.token })).reactions;
  assert(onServer.length === 1 && onServer[0].names[0] === 'alice', 'server: ' + JSON.stringify(onServer));

  // 2b. the add button is the Slack-style outline icon, not an emoji glyph
  const addIcon = await page.$eval(`${msgSel} .msg-actions button[data-act="react"]`, (b) => !!b.querySelector('svg[data-icon="smile-plus"]') && b.textContent.trim() === '');
  assert(addIcon, 'toolbar add-reaction button is not the svg icon');
  assert(await page.$eval(`${msgSel} .msg-reactions .reaction.add svg.rx-add-icon`, (el) => !!el), 'row add button is not the svg icon');

  // 3. bob joins 👀 over the API: the pill count goes to 2 live, the tooltip names both
  await api('/api/v1/messages/' + root.id + '/reactions', { method: 'POST', token: bob.token, body: { emoji: '👀' } });
  await page.waitForFunction((sel) => (document.querySelector(`${sel} .msg-reactions .reaction .rx-count`) || {}).textContent === '2', { timeout: 4000 }, msgSel);
  got = await pills();
  assert(got[0].title === 'alice, bob' && got[0].mine, 'after bob joins: ' + JSON.stringify(got));
  // hovering the pill shows an instant tooltip: "You and bob reacted with :eyes:"
  await page.hover(`${msgSel} .msg-reactions .reaction.mine`);
  await page.waitForSelector('.rx-tip', { timeout: 2000 });
  const tip = await page.$eval('.rx-tip', (el) => el.querySelector('.rx-tip-emoji').textContent + '|' + el.querySelector('.rx-tip-text').textContent);
  assert(tip === '👀|You and bob reacted with :eyes:', 'tooltip: ' + tip);
  await page.screenshot({ path: (process.env.OUT || 'tmp') + '/reactions-tip.png' });
  await page.hover('#channel-title');
  await sleep(150);
  assert(await page.$('.rx-tip') === null, 'tooltip stayed after mouse left');

  // 4. clicking your own pill removes only yours; the pill stays for bob, no longer highlighted
  await page.click(`${msgSel} .msg-reactions .reaction.mine`);
  await page.waitForFunction((sel) => (document.querySelector(`${sel} .msg-reactions .reaction .rx-count`) || {}).textContent === '1', { timeout: 4000 }, msgSel);
  got = await pills();
  assert(got.length === 1 && !got[0].mine && got[0].title === 'bob', 'after alice removes: ' + JSON.stringify(got));

  // 5. the row's own + button opens the picker; search finds :tada:, Enter picks it
  await page.click(`${msgSel} .msg-reactions .reaction.add`);
  await page.waitForSelector('.reaction-picker .rp-search', { timeout: 4000 });
  await page.type('.reaction-picker .rp-search', 'tada');
  await page.waitForSelector('.reaction-picker .rp-results button', { timeout: 4000 });
  const first = await page.$eval('.reaction-picker .rp-results button', (b) => b.textContent + b.title);
  assert(first === '🎉:tada:', 'search hit: ' + first);
  await page.keyboard.press('Enter');
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .msg-reactions .reaction:not(.add)`).length === 2, { timeout: 4000 }, msgSel);
  got = await pills();
  assert(got[1].emoji === '🎉' && got[1].mine, 'after tada: ' + JSON.stringify(got));

  // 6. Esc closes the picker without a pick
  await page.click(`${msgSel} .msg-reactions .reaction.add`);
  await page.waitForSelector('.reaction-picker', { timeout: 4000 });
  await page.keyboard.press('Escape');
  await sleep(200);
  assert(await page.$('.reaction-picker') === null, 'Esc did not close the picker');
  assert((await pills()).length === 2, 'Esc changed reactions');

  // 7. the thread panel's copy of the root shows the same pills and updates live
  await page.click(`${msgSel} .reply-bar`);
  await page.waitForSelector(`#thread-panel .msg[data-id="${root.id}"] .msg-reactions .reaction`, { timeout: 4000 });
  assert(JSON.stringify(await pills('#thread-panel')) === JSON.stringify(got), 'thread copy differs');
  await api('/api/v1/messages/' + root.id + '/reactions/' + encodeURIComponent('👀'), { method: 'DELETE', token: bob.token });
  await page.waitForFunction((id) => document.querySelectorAll(`.msg[data-id="${id}"] .msg-reactions .reaction:not(.add)`).length === 2, { timeout: 4000 }, root.id);
  got = await pills('#thread-panel');
  assert(got.length === 1 && got[0].emoji === '🎉', 'thread copy after bob leaves: ' + JSON.stringify(got));

  // 8. the ⋮ menu also offers Add reaction, after the three standard items
  await page.hover(msgSel);
  await page.click(`${msgSel} .msg-actions button[data-act="more"]`);
  await page.waitForSelector('.context-menu .ctx-item', { timeout: 4000 });
  const labels = await page.$$eval('.context-menu .ctx-item', (bs) => bs.map((b) => b.textContent));
  assert(labels.includes('Add reaction'), 'menu lacks Add reaction: ' + JSON.stringify(labels));
  await page.evaluate(() => [...document.querySelectorAll('.ctx-item')].find((b) => b.textContent === 'Add reaction').click());
  await page.waitForSelector('.reaction-picker', { timeout: 4000 });
  await page.screenshot({ path: (process.env.OUT || 'tmp') + '/reactions.png' });

  await browser.close();
  console.log('REACTIONS_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
