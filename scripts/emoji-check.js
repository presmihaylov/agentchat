// E2E for emoji: ":shortcode:" renders as the character in the feed but stays
// literal inside code, "12:45" and a lone ":" never open the picker, ":rock"
// opens it in both composers, and Enter inserts the character.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/emoji-check.js
const puppeteer = require('puppeteer-core');
const { newRoom } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';

async function api(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status >= 400) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await newRoom(SERVER, 'emoji check');
  const slug = created.room.slug;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'alice', is_human: true } });
  const root = await api('/api/v1/channels/general/messages', {
    method: 'POST', token: alice.token,
    body: { body: 'ship :rocket: at 12:45:00, :nope: stays, `:tada:` is code\n\n```\n:+1:\n```' },
  });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, alice.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction((id) => !!document.querySelector('#messages .msg[data-id="' + id + '"]'), { timeout: 8000 }, root.id);

  // 1. the feed: known shortcode -> character, unknown and code stay literal
  const body = await page.evaluate((id) => document.querySelector('#messages .msg[data-id="' + id + '"] .body').textContent, root.id);
  assert(body.includes('ship 🚀 at 12:45:00'), 'rocket did not render: ' + body);
  assert(body.includes(':nope: stays'), 'unknown code changed: ' + body);
  assert(body.includes(':tada:') && body.includes(':+1:'), 'code was emojified: ' + body);

  // 2. the picker: ":rock" opens, first hit is :rock:, ArrowDown + Enter picks :rocket:
  const ac = '.emoji-ac:not(.hidden)';
  await page.focus('#composer-input');
  await page.type('#composer-input', 'meet at 12:45 :');
  await new Promise((r) => setTimeout(r, 300));
  assert(!(await page.$(ac)), 'a lone ":" opened the picker');
  await page.type('#composer-input', 'rock');
  await page.waitForSelector(ac, { timeout: 5000 });
  const opts = await page.$$eval(ac + ' .mention-opt', (ns) => ns.map((n) => n.textContent));
  assert(/:rock:$/.test(opts[0]) && /:rocket:$/.test(opts[1]), 'options: ' + JSON.stringify(opts));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const typed = await page.$eval('#composer-input', (el) => el.__composer.getPlain());
  assert(typed === 'meet at 12:45 🚀 ', 'inserted: ' + JSON.stringify(typed));
  assert(!(await page.$(ac)), 'picker stayed open after Enter');
  // recently used: :rocket: now beats :rock:
  await page.type('#composer-input', ':rock');
  await page.waitForSelector(ac, { timeout: 5000 });
  const again = await page.$$eval(ac + ' .mention-opt', (ns) => ns.map((n) => n.textContent));
  assert(/:rocket:$/.test(again[0]), 'recent did not rank first: ' + JSON.stringify(again));
  await page.keyboard.press('Escape');
  assert(!(await page.$(ac)), 'Escape did not close the picker');
  await page.screenshot({ path: (process.env.OUT || '.') + '/emoji-picker.png' });
  await page.$eval('#composer-input', (el) => el.__composer.clear());

  // 3. the thread composer has the same picker
  await page.evaluate((id) => document.querySelector('#messages .msg[data-id="' + id + '"] [data-act="thread"]').click(), root.id);
  await page.waitForSelector('#thread-panel:not(.hidden)', { timeout: 8000 });
  await page.focus('#thread-input');
  await page.type('#thread-input', ':tad');
  await page.waitForSelector(ac, { timeout: 5000 });
  await page.keyboard.press('Enter');
  const treply = await page.$eval('#thread-input', (el) => el.__composer.getPlain());
  assert(treply === '🎉 ', 'thread inserted: ' + JSON.stringify(treply));

  await browser.close();
  console.log('EMOJI_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
