// E2E for the Slack-style mention chips. Two families must render distinctly:
//   - pings you: your own name OR a @channel/@here/@everyone broadcast ->
//     warm amber/gold chip (.mention-me)
//   - @someone-else -> subtle blue tint (.mention, no modifier)
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/mention-check.js
const puppeteer = require('puppeteer-core');
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
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'mention check' } });
  const code = created.invite_code, slug = created.room.slug;
  const maya = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'Maya', avatar: '🧑', is_human: true } });
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'orca-infra', avatar: '📊' } });
  // one message that hits all three buckets, authored by the bot so the viewer (Maya) sees @Maya as a self-mention
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'hey @Maya and @orca-infra, @channel please review' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, maya.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.msg .mention', { timeout: 6000 });

  // classify each chip by its text and read the computed color/background
  const chips = await page.evaluate(() => {
    const rgb = (c) => c.replace(/rgba?\(|\)|\s/g, '').split(',').map(Number);
    return [...document.querySelectorAll('.msg .mention')].map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: el.textContent.trim(),
        me: el.classList.contains('mention-me'),
        color: rgb(cs.color),
        bg: rgb(cs.backgroundColor),
      };
    });
  });
  const find = (t) => chips.find((c) => c.text === t);
  const self = find('@Maya'), other = find('@orca-infra'), bc = find('@channel');
  if (!self || !other || !bc) throw new Error('missing a chip: ' + JSON.stringify(chips));

  // amber test: warm text (red channel high, blue channel low)
  const warm = (c) => c.color[0] > 180 && c.color[2] < 120;
  // self chip: amber
  if (!self.me) throw new Error('self chip lost the amber class: ' + JSON.stringify(self));
  if (!warm(self)) throw new Error('self chip is not amber/gold: ' + JSON.stringify(self));

  // broadcast: now the SAME amber chip as self
  if (!bc.me) throw new Error('broadcast chip is not the amber class: ' + JSON.stringify(bc));
  if (!warm(bc)) throw new Error('broadcast chip is not amber/gold: ' + JSON.stringify(bc));

  // other: subtle blue tint, no modifier, blue-forward text
  const bluish = other.color[2] > other.color[0];
  if (other.me) throw new Error('other chip picked up the amber modifier: ' + JSON.stringify(other));
  if (!bluish) throw new Error('other chip is not blue-tinted: ' + JSON.stringify(other));

  await browser.close();
  if (!process.exitCode) console.log('MENTION_CHECK_OK');
})().catch((e) => { console.error('MENTION_CHECK_FAIL:', e.message); process.exit(1); });
