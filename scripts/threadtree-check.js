// E2E: Discord-style thread tree. Threads the viewer is involved in nest as
// leaves under their parent channel in the sidebar. Each leaf glows on unread
// and shows a numeric badge only for unread @mentions (mention-only rule).
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/threadtree-check.js
// Needs a server on $SERVER (default :8095) backed by a live Postgres.
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
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

(async () => {
  const created = await newRoom(SERVER, 'thread tree check');
  const roomCode = created.invite_code, slug = created.room.slug;
  const sender = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'sender', avatar: '🤖' } });
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'viewer', avatar: '🧑', is_human: true } });
  await api('/api/v1/channels', { method: 'POST', token: sender.token, body: { name: 'proj' } });
  // membership: viewer must join #proj to post there and see its threads
  await api('/api/v1/channels/proj/join', { method: 'POST', token: viewer.token });

  const post = (chan, body, root) => api('/api/v1/channels/' + chan + '/messages',
    { method: 'POST', token: (body.startsWith('vv:') ? viewer : sender).token,
      body: { body: body.replace(/^vv:/, ''), thread_root_id: root } });

  // thread A in general: viewer replies (involved), then sender @viewer -> 1 mention
  const rootA = await api('/api/v1/channels/general/messages', { method: 'POST', token: sender.token, body: { body: 'topic A ping' } });
  await post('general', 'vv:on it', rootA.id);
  await post('general', 'hey @viewer look', rootA.id);
  // thread B in proj: viewer replies, sender plain follow-up -> unread, no mention
  const rootB = await api('/api/v1/channels/proj/messages', { method: 'POST', token: sender.token, body: { body: 'topic B plans' } });
  await post('proj', 'vv:sure', rootB.id);
  await post('proj', 'plain follow-up', rootB.id);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#channel-list li', { timeout: 8000 });
  await page.waitForSelector('#channel-list li.thread-leaf', { timeout: 8000 });

  // walk the channel list; each leaf belongs to the channel above it
  const tree = await page.evaluate(() => {
    const out = {}; let cur = null;
    document.querySelectorAll('#channel-list li').forEach((li) => {
      if (!li.classList.contains('thread-leaf')) {
        cur = (li.childNodes[0].textContent || '').replace(/^#\s*/, '').trim().split(' ')[0];
        out[cur] = [];
        return;
      }
      const badge = li.querySelector('.t-count');
      out[cur].push({
        snippet: li.querySelector('.t-snippet').textContent,
        glow: li.classList.contains('unread'),
        badge: badge ? badge.textContent : null,
      });
    });
    return out;
  });

  const leafIn = (chan, needle) => (tree[chan] || []).find((l) => l.snippet.includes(needle));
  const a = leafIn('general', 'topic A');
  if (!a) fail('thread A leaf not nested under #general: ' + JSON.stringify(tree));
  else {
    if (!a.glow) fail('thread A leaf not glowing');
    if (a.badge !== '1') fail('thread A leaf badge=' + JSON.stringify(a.badge) + ', want "1" (one @mention)');
  }
  const b = leafIn('proj', 'topic B');
  if (!b) fail('thread B leaf not nested under #proj: ' + JSON.stringify(tree));
  else {
    if (!b.glow) fail('thread B leaf not glowing (it has an unread plain reply)');
    if (b.badge !== null) fail('thread B leaf badge=' + JSON.stringify(b.badge) + ', want none (no mention)');
  }
  // a thread must not leak under the wrong channel
  if (leafIn('general', 'topic B') || leafIn('proj', 'topic A')) fail('a thread nested under the wrong channel');

  await browser.close();
  if (!process.exitCode) console.log('THREADTREE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
