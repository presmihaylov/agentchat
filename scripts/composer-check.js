// E2E: the rich composer. Verifies auto-grow, Enter-to-send / Shift+Enter
// newline, a markdown shortcut (bold), URL-paste -> markdown link, and the
// live preview toggle. The wire format stays plain markdown.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/composer-check.js
const puppeteer = require('puppeteer-core');
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
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'composer check' } });
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

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#composer-input', { timeout: 6000 });

  const ta = '#composer-input';
  const height = () => page.$eval(ta, (el) => el.getBoundingClientRect().height);
  const value = () => page.$eval(ta, (el) => el.value);

  // 1) auto-grow: several Shift+Enter lines make it taller than a single row
  const h0 = await height();
  await page.click(ta);
  for (let i = 1; i <= 5; i++) {
    await page.type(ta, 'line' + i);
    if (i < 5) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
  }
  const h1 = await height();
  if (h1 <= h0 + 10) fail(`auto-grow did not grow: ${h0} -> ${h1}`);
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }, ta);

  // 2) Shift+Enter inserts a newline, does NOT send
  await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, ta);
  await page.click(ta);
  await page.type(ta, 'first');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.type(ta, 'second');
  if (!(await value()).includes('\n')) fail('Shift+Enter did not insert a newline');

  // 3) bold shortcut wraps the selection
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.value = 'hello'; el.setSelectionRange(0, 5); }, ta);
  await page.keyboard.down('Control'); await page.keyboard.press('b'); await page.keyboard.up('Control');
  const boldVal = await value();
  if (boldVal !== '**hello**') fail(`bold shortcut = ${JSON.stringify(boldVal)}, want "**hello**"`);

  // 4) paste a URL over a selection -> markdown link
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.value = 'the docs'; el.focus(); el.setSelectionRange(4, 8); // select "docs"
    const dt = new DataTransfer(); dt.setData('text/plain', 'https://example.com/x');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, ta);
  const linkVal = await value();
  if (linkVal !== 'the [docs](https://example.com/x)') fail(`url paste = ${JSON.stringify(linkVal)}, want "the [docs](https://example.com/x)"`);

  // 5) preview toggle renders markdown (bold -> <strong>)
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.value = '**bold** and `code`'; el.dispatchEvent(new Event('input', { bubbles: true })); }, ta);
  await page.evaluate(() => document.querySelector('.composer-tools[data-for="composer-input"] [data-fmt="preview"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  const pvHTML = await page.$eval('.composer-preview[data-for="composer-input"]', (el) => el.innerHTML);
  if (!/<strong>bold<\/strong>/.test(pvHTML) || !/<code>code<\/code>/.test(pvHTML)) fail(`preview did not render markdown: ${pvHTML}`);

  // 6) Enter sends the current markdown verbatim
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.value = '**shipped** it'; el.dispatchEvent(new Event('input', { bubbles: true })); }, ta);
  await page.click(ta);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#messages .content')].some((c) => /<strong>shipped<\/strong>/.test(c.innerHTML)), { timeout: 5000 })
    .catch(() => fail('sent message did not render bold markdown in the feed'));

  await browser.close();
  if (!process.exitCode) console.log('COMPOSER_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
