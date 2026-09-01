// E2E guard for the compact message type scale: message text runs ~20% under
// the 15px chrome base (12px), the markdown scale follows via em units, and the
// thread panel uses the same scale as the feed. Chrome (composer) stays 15px.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/density-check.js
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
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'density check' } });
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'densbot', description: 't' } });
  const human = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', is_human: true } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: '## Heading here\n\nbody text with `inline code`' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'a reply in the thread', thread_root_id: root.id } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, human.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length >= 1, { timeout: 8000 });

  const px = (v) => parseFloat(v);
  const feed = await page.evaluate(() => {
    const msg = [...document.querySelectorAll('#messages .msg')].find((n) => n.textContent.includes('body text'));
    const gs = (el) => getComputedStyle(el).fontSize;
    return {
      content: gs(msg.querySelector('.content')),
      heading: gs(msg.querySelector('.content h2')),
      code: gs(msg.querySelector('.content code')),
      author: gs(msg.querySelector('.meta .author')),
      avatar: msg.querySelector('.avatar').getBoundingClientRect().width,
      composer: gs(document.querySelector('.composer-editor')),
    };
  });
  assert(px(feed.content) === 12, 'feed content ' + feed.content + ', want 12px');
  assert(Math.abs(px(feed.heading) - 15) <= 0.5, 'h2 ' + feed.heading + ', want ~15px (1.25em of 12)');
  assert(px(feed.code) < 12, 'inline code ' + feed.code + ', want under the 12px body (em-scaled)');
  assert(px(feed.author) === 12, 'author ' + feed.author + ', want 12px');
  assert(feed.avatar === 28, 'avatar width ' + feed.avatar + ', want 28');
  assert(px(feed.composer) === 15, 'composer ' + feed.composer + ', want 15px (chrome keeps the base)');

  // thread panel runs the same scale
  await page.evaluate(() => {
    [...document.querySelectorAll('#messages .msg')].find((n) => n.querySelector('.reply-bar'))?.querySelector('.reply-bar').click();
  });
  await page.waitForFunction(() => document.querySelectorAll('#thread-messages .msg').length >= 1, { timeout: 8000 });
  const thread = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#thread-messages .msg .content')).fontSize);
  assert(px(thread) === 12, 'thread content ' + thread + ', want 12px');

  await browser.close();
  console.log('DENSITY_CHECK_OK');
})().catch((e) => { console.error('DENSITY_CHECK_FAIL:', e.message); process.exit(1); });
