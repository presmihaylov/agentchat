// E2E for markdown block rendering in messages (FR-G). A blank line between
// paragraphs must render as a real vertical gap (not collapse), and the common
// block elements (headings, lists, blockquote, hr) must all render.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/mdrender-check.js
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

const BRIEF = [
  '## Heading two',
  '',
  'First paragraph here.',
  '',
  'Second paragraph, separated by a blank line.',
  '',
  '### Heading three',
  '',
  '- bullet one',
  '- bullet two',
  '',
  '1. numbered one',
  '2. numbered two',
  '',
  '> a blockquote line',
  '',
  '---',
  '',
  'Closing paragraph.',
].join('\n');

(async () => {
  const created = await newRoom(SERVER, 'mdrender check');
  const code = created.invite_code, slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'viewer', avatar: '🧑', is_human: true } });
  const author = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'briefbot', avatar: '📋' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: author.token, body: { body: BRIEF } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

    await openAsHuman(page, SERVER, slug, viewer);
  await page.waitForSelector('#messages .msg .content', { timeout: 6000 });

  // every expected block element rendered
  const tags = await page.$eval('#messages .msg .content', (el) => [...el.children].map((c) => c.tagName));
  for (const want of ['H2', 'H3', 'UL', 'OL', 'BLOCKQUOTE', 'HR']) {
    if (!tags.includes(want)) fail(`missing block <${want}>; got ${tags.join(',')}`);
  }
  if (tags.filter((t) => t === 'P').length < 3) fail(`expected >=3 paragraphs, got ${tags.join(',')}`);

  // the blank line between the first two paragraphs is a real gap, not a collapse
  const gap = await page.$eval('#messages .msg .content', (el) => {
    const ps = [...el.querySelectorAll(':scope > p')];
    const a = ps[0].getBoundingClientRect(), b = ps[1].getBoundingClientRect();
    return b.top - a.bottom;
  });
  if (gap < 6) fail(`paragraph gap = ${gap}px, want >= 6 (collapsed spacing regressed)`);

  // blockquote carries the themed left border
  const bqBorder = await page.$eval('#messages .msg .content blockquote', (el) => getComputedStyle(el).borderLeftWidth);
  if (parseFloat(bqBorder) < 2) fail(`blockquote left border = ${bqBorder}, want >= 2px`);

  await browser.close();
  if (!process.exitCode) console.log('MDRENDER_CHECK_OK (paragraph gap ' + Math.round(gap) + 'px)');
})().catch((e) => { console.error(e); process.exit(1); });
