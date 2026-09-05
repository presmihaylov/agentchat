// E2E for the one-unit composer (task 16, Maya msg 42e8199f): the paperclip and
// the send button live inside the composer border, the send button is muted while
// the editor is empty and accent once there is text, the box grows upward with
// the text, the action bar never joins a text selection, and a send still lands.
// Run: NODE_PATH=<puppeteer dir> SERVER=http://localhost:8095 node scripts/composer-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';
require('fs').mkdirSync(OUT, { recursive: true });
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
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
  const created = await newRoom(SERVER, 'composer check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await openAsHuman(page, SERVER, slug, alice);
  await page.waitForSelector('#composer-input', { timeout: 8000 });

  // 1. structure: editor, then a bar holding the paperclip, the hint and the send button, all inside one box
  const shape = await page.$eval('#composer .composer-main', (box) => ({
    empty: box.classList.contains('empty'),
    kids: [...box.children].map((c) => c.className.split(' ')[0]),
    clip: !!box.querySelector('.composer-bar #attach-label svg[data-icon="paperclip"]'),
    send: !!box.querySelector('.composer-bar button.composer-send[type="submit"] svg[data-icon="arrow-up"]'),
    sendText: box.querySelector('.composer-send').textContent.trim(),
    hint: box.querySelector('.composer-hint').textContent,
    barSelect: getComputedStyle(box.querySelector('.composer-bar')).userSelect,
    border: getComputedStyle(box).borderTopWidth,
    editorBorder: getComputedStyle(box.querySelector('.ProseMirror')).borderTopWidth,
  }));
  assert(shape.kids.slice(0, 2).join(',') === 'composer-editor,composer-bar', 'box children: ' + shape.kids);
  assert(shape.clip && shape.send && shape.sendText === '', 'inline icons missing: ' + JSON.stringify(shape));
  assert(shape.empty, 'send not muted while empty');
  assert(/Enter/.test(shape.hint) && /Shift/.test(shape.hint), 'keyboard hint: ' + shape.hint);
  assert(shape.barSelect === 'none', 'bar is selectable');
  assert(shape.border === '1px' && shape.editorBorder === '0px', 'border: ' + shape.border + ' editor ' + shape.editorBorder);
  const mutedBg = await page.$eval('#composer .composer-send', (b) => getComputedStyle(b).backgroundColor);

  // 2. typing turns the send button accent; Shift+Enter grows the box upward
  const before = await page.$eval('#composer .composer-main', (b) => { const r = b.getBoundingClientRect(); return { height: r.height, bottom: r.bottom }; });
  await page.click('#composer-input');
  await page.keyboard.type('first line');
  await page.waitForFunction(() => !document.querySelector('#composer .composer-main').classList.contains('empty'), { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 300)); // let the colour transition finish
  const accentBg = await page.$eval('#composer .composer-send', (b) => getComputedStyle(b).backgroundColor);
  assert(accentBg !== mutedBg, 'send colour did not change with text');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.keyboard.type('second line');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.keyboard.type('third line');
  const after = await page.$eval('#composer .composer-main', (b) => { const r = b.getBoundingClientRect(); return { height: r.height, bottom: r.bottom }; });
  assert(after.height > before.height + 20, 'box did not grow: ' + before.height + ' -> ' + after.height);
  assert(Math.abs(after.bottom - before.bottom) < 2, 'box did not grow upward: bottom ' + before.bottom + ' -> ' + after.bottom);
  if (OUT) await page.screenshot({ path: OUT + '/composer-grown.png' });

  // 3. the inline send button posts and the box empties again
  await page.click('#composer .composer-send');
  await page.waitForFunction(() => /third line/.test(document.querySelector('#messages').textContent), { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#composer .composer-main').classList.contains('empty'), { timeout: 3000 });
  const shrunk = await page.$eval('#composer .composer-main', (b) => b.getBoundingClientRect().height);
  assert(shrunk < after.height, 'box did not shrink after send');

  // 4. the thread composer has the same shape
  const thread = await page.$eval('#thread-composer .composer-main', (box) => ({
    clip: !!box.querySelector('.composer-bar #thread-attach-label svg[data-icon="paperclip"]'),
    send: !!box.querySelector('.composer-bar button.composer-send svg[data-icon="arrow-up"]'),
    empty: box.classList.contains('empty'),
  }));
  assert(thread.clip && thread.send && thread.empty, 'thread composer: ' + JSON.stringify(thread));
  if (OUT) await page.screenshot({ path: OUT + '/composer.png' });
  await browser.close();
  console.log('COMPOSER_CHECK_OK');
})().catch((e) => { console.error('COMPOSER_CHECK_FAIL:', e.message); process.exit(1); });
