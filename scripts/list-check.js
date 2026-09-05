// E2E: list continuation in the composer (Maya FR).
// A markdown marker typed after Shift-Enter starts a list, not just on the
// first line, and Enter inside a list makes the next item instead of sending.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/list-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';

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
  const created = await newRoom(SERVER, 'list check');
  const slug = created.room.slug;
  const human = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'humantester', avatar: '🧑', is_human: true } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });

    await openAsHuman(page, SERVER, slug, human);
  await page.waitForSelector('#composer-input', { timeout: 6000 });

  const clear = () => page.evaluate(() => { document.querySelector('#composer-input').__composer.clear(); document.querySelector('#composer-input').__composer.focus(); });
  const md = () => page.evaluate(() => document.querySelector('#composer-input').__composer.getMarkdown());
  const items = () => page.evaluate(() => document.querySelectorAll('#composer-input li').length);
  const softBreak = async () => { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); };

  // 1) BULLETS AFTER A SOFT BREAK: the marker fires on line 2, not only line 1
  await clear();
  await page.type('#composer-input', 'intro line');
  await softBreak();
  await page.type('#composer-input', '* first');
  if (await items() !== 1) throw new Error('"* " after Shift-Enter did not start a bullet list: ' + await md());

  // 2) ENTER CONTINUES THE LIST instead of sending the message
  await page.keyboard.press('Enter');
  await page.type('#composer-input', 'second');
  if (await items() !== 2) throw new Error('Enter did not make a second item: ' + await md());
  let out = await md();
  if (!/intro line/.test(out)) throw new Error('the text above the list was lost: ' + out);
  if (!/[-*] first/.test(out) || !/[-*] second/.test(out)) throw new Error('list did not serialize as markdown: ' + out);

  // 3) TWO ENTERS LEAVE THE LIST, and the next Enter still sends
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  if (await items() !== 2) throw new Error('an empty item should lift out of the list: ' + await md());
  await page.type('#composer-input', 'tail');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('tail'), { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#composer-input').__composer.getMarkdown().trim() === '', { timeout: 4000 });

  // 4) NUMBERS TOO: "1. " after a soft break makes an ordered list
  await clear();
  await page.type('#composer-input', 'steps:');
  await softBreak();
  await page.type('#composer-input', '1. one');
  if (await page.evaluate(() => document.querySelectorAll('#composer-input ol li').length) !== 1) {
    throw new Error('"1. " after Shift-Enter did not start an ordered list: ' + await md());
  }
  await page.keyboard.press('Enter');
  await page.type('#composer-input', 'two');
  out = await md();
  if (!/1\. one/.test(out) || !/2\. two/.test(out)) throw new Error('ordered list did not serialize: ' + out);

  // 5) THE FIRST LINE STILL WORKS (the stock input rule is untouched)
  await clear();
  await page.type('#composer-input', '- top');
  if (await items() !== 1) throw new Error('a marker on the first line stopped working: ' + await md());

  // 6) A LIST SURVIVES THE ROUND TRIP: send it and read it back in the feed
  await clear();
  await page.type('#composer-input', 'plan');
  await softBreak();
  await page.type('#composer-input', '* alpha');
  await page.keyboard.press('Enter');
  await page.type('#composer-input', 'beta');
  await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
  await page.waitForFunction(() => {
    const li = [...document.querySelectorAll('#messages li')].map((x) => x.textContent);
    return li.includes('alpha') && li.includes('beta');
  }, { timeout: 8000 });

  await browser.close();
  if (!process.exitCode) console.log('LIST_CHECK_OK');
})().catch((e) => { console.error('LIST_CHECK_FAIL:', e.message); process.exit(1); });
