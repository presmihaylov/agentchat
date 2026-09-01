// E2E: membership events render as muted inline system entries in the timeline,
// arrive live without a refresh, and never bump the channel unread badge.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/systementry-check.js
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'systementry check' } });
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'membot', description: 't' } });
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', avatar: '🧑', is_human: true } });
  await api('/api/v1/channels', { method: 'POST', token: bot.token, body: { name: 'proj', topic: '' } });
  await api('/api/v1/channels/proj/join', { method: 'POST', token: viewer.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() =>
    document.querySelector('#channel-list li.active')?.textContent.includes('general'), { timeout: 8000 });

  const projLi = () => [...document.querySelectorAll('#channel-list li')]
    .find((li) => li.textContent.includes('proj'));

  // membership churn in #proj while the viewer watches #general
  await api('/api/v1/channels/proj/leave', { method: 'POST', token: bot.token });
  await sleep(3500); // give the event stream time to deliver
  const unreadAfterLeave = await page.evaluate(`(${projLi})().classList.contains('unread')`);
  assert(!unreadAfterLeave, 'system entry bumped the #proj unread badge');

  // positive control: a real message DOES bump it, so the negative above is live
  await api('/api/v1/channels/proj/join', { method: 'POST', token: bot.token });
  await api('/api/v1/channels/proj/messages', { method: 'POST', token: bot.token, body: { body: 'hello proj' } });
  await page.waitForFunction(`(${projLi})().classList.contains('unread')`, { timeout: 8000 })
    .catch(() => { throw new Error('real message did not bump the #proj unread badge (events dead?)'); });

  // open #proj: the timeline shows the muted entries inline, avatar-free
  await page.evaluate(`(${projLi})().click()`);
  await page.waitForFunction(() =>
    document.querySelector('#channel-title')?.textContent.includes('proj'), { timeout: 8000 });
  await page.waitForFunction(() =>
    document.querySelectorAll('#messages .msg.system-entry').length >= 3, { timeout: 8000 })
    .catch(() => { throw new Error('timeline is missing the system entries'); });
  const entries = await page.evaluate(() =>
    [...document.querySelectorAll('#messages .msg.system-entry')].map((el) => ({
      text: el.textContent.trim(),
      hasAvatar: !!el.querySelector('.avatar, img'),
      hasReply: !!el.querySelector('button'),
    })));
  const texts = entries.map((e) => e.text);
  assert(texts.some((t) => t.includes('viewer') && t.includes('joined #proj')), 'no "viewer joined" entry: ' + JSON.stringify(texts));
  assert(texts.some((t) => t.includes('membot') && t.includes('left #proj')), 'no "membot left" entry: ' + JSON.stringify(texts));
  assert(texts.some((t) => t.includes('membot') && t.includes('joined #proj')), 'no "membot joined" entry: ' + JSON.stringify(texts));
  assert(entries.every((e) => !e.hasAvatar && !e.hasReply), 'a system entry has an avatar or action button');
  const feed = await page.evaluate(() => document.querySelector('#messages').textContent);
  assert(feed.includes('hello proj'), 'the real message is missing from the timeline');

  // live: a new membership event lands in the open timeline without a reload
  await api('/api/v1/channels/proj/leave', { method: 'POST', token: bot.token });
  await page.waitForFunction(() =>
    document.querySelectorAll('#messages .msg.system-entry').length >= 4, { timeout: 8000 })
    .catch(() => { throw new Error('live system entry did not appear without a refresh'); });

  await browser.close();
  console.log('SYSTEMENTRY_CHECK_OK');
})().catch((e) => { console.error('SYSTEMENTRY_CHECK_FAIL:', e.message); process.exit(1); });
