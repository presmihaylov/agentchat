// E2E: Discord-style thread tree. Threads the viewer is involved in nest as
// leaves under their parent channel in the sidebar. Each leaf glows on unread
// and shows a numeric badge only for unread @mentions (mention-only rule).
// The leaves hang off a drawn tree guide: a continuous trunk with an elbow on
// the last leaf (Maya, 2026-09-05), checked by geometry and computed style.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/threadtree-check.js
// Needs a server on $SERVER (default :8095) backed by a live Postgres.
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
  // thread C in general too, so #general carries two leaves and the tree guide
  // has a trunk to draw between them
  const rootC = await api('/api/v1/channels/general/messages', { method: 'POST', token: sender.token, body: { body: 'topic C later' } });
  await post('general', 'vv:noted', rootC.id);
  // thread B in proj: viewer replies, sender plain follow-up -> unread, no mention
  const rootB = await api('/api/v1/channels/proj/messages', { method: 'POST', token: sender.token, body: { body: 'topic B plans' } });
  await post('proj', 'vv:sure', rootB.id);
  await post('proj', 'plain follow-up', rootB.id);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 }); // the sidebar folds away on a narrow default viewport
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

    await openAsHuman(page, SERVER, slug, viewer);
  await page.waitForSelector('#channel-list li', { timeout: 8000 });
  await page.waitForSelector('#channel-list li.thread-leaf', { timeout: 8000 });

  // walk the channel list; each leaf belongs to the channel above it
  const tree = await page.evaluate(() => {
    const out = {}; let cur = null;
    document.querySelectorAll('#channel-list li').forEach((li) => {
      if (!li.classList.contains('thread-leaf')) {
        cur = ((li.querySelector('.chan-name') || {}).textContent || '').trim().split(' ')[0];
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

  // the tree guide is drawn, not glyphs: one continuous trunk from the first
  // leaf down to the middle of the last one, an elbow tick on every row
  const guide = await page.evaluate(() => {
    const leaves = [...document.querySelectorAll('#channel-list li.thread-leaf')];
    const rows = leaves.map((li) => {
      const icon = li.querySelector('.t-icon');
      const r = li.getBoundingClientRect(), ir = icon.getBoundingClientRect();
      const trunk = getComputedStyle(icon, '::before'), tick = getComputedStyle(icon, '::after');
      return {
        last: li.classList.contains('last'), top: r.top, bottom: r.bottom, iconTop: ir.top, iconBottom: ir.bottom,
        glyph: trunk.content, trunkStyle: trunk.borderLeftStyle, trunkTop: trunk.top, trunkBottom: trunk.bottom,
        tickStyle: tick.borderTopStyle, tickTop: tick.top, color: trunk.borderLeftColor,
      };
    });
    // #general's two leaves are the first two rows of the list
    return { rows, gap: rows.length > 1 ? rows[1].top - rows[0].bottom : null };
  });
  const rows = guide.rows;
  if (rows.length < 3) fail('expected three leaves, got ' + rows.length);
  for (const r of rows) {
    if (r.glyph !== '""') fail('a leaf still carries a text glyph: ' + r.glyph);
    if (r.trunkStyle !== 'solid' || r.tickStyle !== 'solid') fail('guide not drawn with borders: ' + JSON.stringify(r));
    // percentages resolve to px once laid out: the middle is half the icon column
    const half = (r.iconBottom - r.iconTop) / 2, near = (v) => Math.abs(parseFloat(v) - half) < 0.6;
    if (!near(r.tickTop)) fail('elbow tick not at the row middle: ' + r.tickTop + ' vs ' + half);
    if (Math.abs(r.iconTop - (r.top + 4)) > 0.6 || Math.abs(r.iconBottom - (r.bottom - 4)) > 0.6) fail('icon column does not span the row: ' + JSON.stringify(r));
    // the trunk reaches 4px past the icon on both ends, i.e. the row edges, so two
    // flush rows join with no gap; the last leaf stops at its middle (the elbow)
    if (r.trunkTop !== '-4px') fail('trunk does not start at the row top: ' + r.trunkTop);
    if (!r.last && r.trunkBottom !== '-4px') fail('trunk does not reach the row bottom: ' + r.trunkBottom);
    if (r.last && !near(r.trunkBottom)) fail('last leaf trunk should stop at the middle: ' + r.trunkBottom + ' vs ' + half);
  }
  if (rows[0].last) fail('the first of two leaves is marked last');
  if (!rows[1].last) fail('the second leaf under #general is not marked last');
  if (guide.gap !== 0) fail('leaf rows are not flush, the trunk would break: gap=' + guide.gap);
  const fs = require('fs'); fs.mkdirSync('tmp', { recursive: true });
  const side = await page.$('#sidebar');
  await side.screenshot({ path: 'tmp/threadtree-guide.png' });

  await browser.close();
  if (!process.exitCode) console.log('THREADTREE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
