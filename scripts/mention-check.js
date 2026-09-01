// E2E for dead-mention hardening: the API rejects a handle nobody answers to,
// the UI still lets a human type literal "@text", and mentioning somebody who
// is not in the channel warns the sender instead of vanishing.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/mention-check.js
const puppeteer = require('puppeteer-core');
const SERVER = process.env.SERVER || 'http://localhost:8095';

async function call(path, opts = {}) {
  const resp = await fetch(SERVER + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}
async function api(path, opts = {}) {
  const { status, data } = await call(path, opts);
  if (status >= 400) throw new Error(path + ' -> ' + status + ' ' + JSON.stringify(data));
  return data;
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'mention check' } });
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'mentionbot', description: 't' } });
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', is_human: true } });

  // 1. the roster is fetchable and lists both handles
  const roster = await api('/api/v1/members', { token: bot.token });
  const handles = roster.members.map((m) => m.handle).sort();
  assert(handles.join(',') === 'mentionbot,viewer', 'roster handles: ' + handles);
  assert(roster.members.every((m) => m.dormant === false), 'a fresh member is dormant');

  // 2. an unknown handle is a 422 carrying the roster
  const bad = await call('/api/v1/channels/general/messages', {
    method: 'POST', token: bot.token, body: { body: 'ping @ghost' },
  });
  assert(bad.status === 422, 'unknown mention -> ' + bad.status);
  assert(bad.data.unknown_mentions[0] === 'ghost', 'unknown_mentions: ' + JSON.stringify(bad.data));
  assert(bad.data.members.length === 2, 'the 422 must carry the roster');

  // 3. an out-of-channel mention posts, with a warning
  const priv = await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'botonly' } });
  const warned = await api('/api/v1/channels/' + priv.id + '/messages', {
    method: 'POST', token: bot.token, body: { body: 'hi @viewer' },
  });
  assert(warned.warnings && /viewer/.test(warned.warnings[0]), 'no warning: ' + JSON.stringify(warned));

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  let alerted = null;
  page.on('dialog', async (d) => { alerted = d.message(); await d.dismiss(); });
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  // 4. a human typing literal "@text" is never blocked
  await page.type('#composer-input', 'see @ghost-branch for the fix ');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#messages .msg')]
    .some((m) => m.textContent.includes('ghost-branch')), { timeout: 8000 });
  assert(!alerted, 'the UI blocked a literal @text: ' + alerted);

  // 5. the human mentioning an out-of-channel member sees the warning pill
  await api('/api/v1/channels', { method: 'POST', token: viewer.token, body: { name: 'viewer-only' } });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li')]
    .find((li) => li.textContent.includes('viewer-only')).click());
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('viewer-only'), { timeout: 8000 });
  // the trailing space dismisses the mention popup, so Enter sends instead of
  // picking a suggestion
  await page.type('#composer-input', 'hey @mentionbot ');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const n = document.getElementById('notice');
    return n && !n.classList.contains('hidden') && /mentionbot/.test(n.textContent);
  }, { timeout: 8000 });

  await page.screenshot({ path: (process.env.OUT || '.') + '/mention-warning.png' });

  await browser.close();
  console.log('MENTION_CHECK_OK');
})().catch((e) => { console.error('MENTION_CHECK_FAIL:', e.message); process.exit(1); });
