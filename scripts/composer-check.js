// E2E: the Tiptap WYSIWYG composer. Verifies auto-grow, Enter-to-send /
// Shift+Enter newline, the bold shortcut, URL-paste -> link on the selection,
// live WYSIWYG marks, and that the wire format stays plain markdown.
// The contenteditable keeps the old textarea's id and a `.value` markdown shim.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/composer-check.js
const puppeteer = require('puppeteer-core');
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

(async () => {
  const created = await newRoom(SERVER, 'composer check');
  const code = created.invite_code, slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'viewer', avatar: '🧑', is_human: true } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 900, deviceScaleFactor: 1 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

    await openAsHuman(page, SERVER, slug, viewer);
  await page.waitForSelector('#composer-input', { timeout: 6000 });

  const ta = '#composer-input';
  const height = () => page.$eval(ta, (el) => el.getBoundingClientRect().height);
  const value = () => page.$eval(ta, (el) => el.value); // markdown shim
  const clear = () => page.evaluate((sel) => document.querySelector(sel).__composer.clear(), ta);
  const shiftEnter = async () => { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); };
  const meta = async (key) => { await page.keyboard.down('Meta'); await page.keyboard.press(key); await page.keyboard.up('Meta'); };

  // 1) auto-grow: several Shift+Enter lines make the editor taller
  const h0 = await height();
  await page.click(ta);
  for (let i = 1; i <= 5; i++) {
    await page.type(ta, 'line' + i);
    if (i < 5) await shiftEnter();
  }
  const h1 = await height();
  if (h1 <= h0 + 10) fail(`auto-grow did not grow: ${h0} -> ${h1}`);
  await clear();

  // 2) Shift+Enter inserts a newline, does NOT send
  await page.click(ta);
  await page.type(ta, 'first');
  await shiftEnter();
  await page.type(ta, 'second');
  if ((await value()) !== 'first\nsecond') fail('Shift+Enter newline: got ' + JSON.stringify(await value()));
  const posted = await api('/api/v1/channels/general/messages?limit=10', { token: viewer.token });
  if ((posted.messages || []).length) fail('Shift+Enter posted a message');
  await clear();

  // 3) bold shortcut marks the selection; the wire form is **...**
  await page.click(ta);
  await page.type(ta, 'hello');
  await meta('a');
  await meta('b');
  if ((await value()) !== '**hello**') fail(`bold shortcut = ${JSON.stringify(await value())}, want "**hello**"`);
  const boldDOM = await page.$eval(ta, (el) => el.innerHTML);
  if (!/<strong>hello<\/strong>/.test(boldDOM)) fail('bold not WYSIWYG in the editor: ' + boldDOM);
  await clear();

  // 4) paste a URL over a selection -> link on the selected text
  await page.click(ta);
  await page.type(ta, 'the docs');
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    // select "docs" (doc positions: paragraph starts at 1)
    el.__composer.editor.commands.setTextSelection({ from: 5, to: 9 });
    const dt = new DataTransfer(); dt.setData('text/plain', 'https://example.com/x');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, ta);
  const linkVal = await value();
  if (linkVal !== 'the [docs](https://example.com/x)') fail(`url paste = ${JSON.stringify(linkVal)}, want "the [docs](https://example.com/x)"`);
  await clear();

  // 5) setting markdown renders WYSIWYG marks in the editor (no raw syntax)
  await page.evaluate((sel) => { document.querySelector(sel).value = '**bold** and `code`'; }, ta);
  const wys = await page.$eval(ta, (el) => el.innerHTML);
  if (!/<strong>bold<\/strong>/.test(wys) || !/<code[^>]*>code<\/code>/.test(wys)) fail(`markdown not rendered WYSIWYG: ${wys}`);

  // 6) Enter sends, and the wire body is the exact markdown
  await page.evaluate((sel) => { document.querySelector(sel).value = '**shipped** it'; }, ta);
  await page.evaluate((sel) => document.querySelector(sel).__composer.focus(), ta);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#messages .content')].some((c) => /<strong>shipped<\/strong>/.test(c.innerHTML)), { timeout: 5000 })
    .catch(() => fail('sent message did not render bold markdown in the feed'));
  // the feed renders optimistically; poll the API for the persisted body
  let bodies = [];
  for (let i = 0; i < 20 && !bodies.includes('**shipped** it'); i++) {
    await new Promise((r) => setTimeout(r, 250));
    const after = await api('/api/v1/channels/general/messages?limit=5', { token: viewer.token });
    bodies = (after.messages || []).map((m) => m.body);
  }
  if (!bodies.includes('**shipped** it')) fail('wire body changed: ' + JSON.stringify(bodies));

  // 7) typed plain text hits the wire verbatim — no backslash or entity
  // escaping (regression: the stock serializer escapes _ * [ ] and <>&)
  const RAW = 'snake_case and a > b and 2*3';
  await clear();
  await page.click(ta);
  await page.type(ta, RAW);
  await page.keyboard.press('Enter');
  let rawSeen = [];
  for (let i = 0; i < 20 && !rawSeen.includes(RAW); i++) {
    await new Promise((r) => setTimeout(r, 250));
    const out = await api('/api/v1/channels/general/messages?limit=5', { token: viewer.token });
    rawSeen = (out.messages || []).map((m) => m.body);
  }
  if (!rawSeen.includes(RAW)) fail('plain text was escaped on the wire: ' + JSON.stringify(rawSeen));

  await browser.close();
  if (!process.exitCode) console.log('COMPOSER_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
