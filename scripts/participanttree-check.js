// E2E: participants tree. Each human is a parent; the agents whose
// server-verified owner_id points at them nest as leaves beneath, with an
// owner-badged avatar. Ownerless agents group under an "unowned agents" node.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/participanttree-check.js
// Needs a server on $SERVER (default :8095) backed by a live Postgres.
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs } = require('./lib/login.js');
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
const join = (code, name, avatar, human) => api('/api/v1/rooms/join',
  { method: 'POST', body: { invite_code: code, name, avatar, is_human: !!human } });
const mint = (tok) => api('/api/v1/invites', { method: 'POST', token: tok, body: { bind_owner: true } }).then((r) => r.join_url);

(async () => {
  const created = await newRoom(SERVER, 'participant tree check');
  const roomCode = created.invite_code, slug = created.room.slug;

  const maya = await join(roomCode, 'maya', '🧑', true);
  const dana = await join(roomCode, 'dana', '👩', true);
  // only admins and agents mint links: maya (first joiner, admin) promotes dana first
  await api('/api/v1/participants/' + dana.participant.id + '/role', { method: 'POST', token: maya.token, body: { role: 'admin' } });
  const mayaCode = await mint(maya.token), danaCode = await mint(dana.token);
  await join(mayaCode, 'mayabot1', '🤖');   // owned by maya
  await join(mayaCode, 'mayabot2', '🛰️');    // owned by maya
  await join(danaCode, 'danabot', '🐝');     // owned by dana
  await join(roomCode, 'lonerbot', '👽');    // ownerless

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  await enterAs(page, SERVER, slug, roomCode, 'viewer');
  await page.waitForSelector('#participant-list li.participant-leaf', { timeout: 8000 });

  // humans collapse their agents by default; expand maya and dana via the chevron.
  for (const name of ['maya', 'dana']) {
    await page.evaluate((n) => {
      const li = [...document.querySelectorAll('#participant-list li')].find((x) => (x.querySelector('.pname') || {}).textContent === n);
      if (li) (li.querySelector('.p-toggle') || li).click();
    }, name);
  }
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('#participant-list li .pname')].map((e) => e.textContent);
    return ['mayabot1', 'mayabot2', 'danabot'].every((n) => names.includes(n));
  }, { timeout: 4000 });

  // walk the flat <li> list into parent -> [children] using the leaf class
  const rows = await page.evaluate(() => {
    const out = []; let cur = null;
    document.querySelectorAll('#participant-list li').forEach((li) => {
      if (li.classList.contains('offline-toggle')) return;
      const name = (li.querySelector('.pname')?.textContent) ||
        (li.classList.contains('group-label') ? '#' + li.textContent : '?');
      const badge = !!li.querySelector('.owner-badge-av');
      if (li.classList.contains('participant-leaf')) { if (cur) cur.kids.push({ name, badge }); return; }
      cur = { name, label: li.classList.contains('group-label'), kids: [] };
      out.push(cur);
    });
    return out;
  });

  const parent = (n) => rows.find((r) => r.name === n);
  const kidNames = (r) => (r ? r.kids.map((k) => k.name) : []);

  // maya parents its two bots, each owner-badged
  const p = parent('maya');
  if (!p) fail('maya parent row missing: ' + JSON.stringify(rows));
  else {
    if (JSON.stringify(kidNames(p).sort()) !== JSON.stringify(['mayabot1', 'mayabot2']))
      fail('maya kids = ' + JSON.stringify(kidNames(p)) + ', want mayabot1/mayabot2');
    if (!p.kids.every((k) => k.badge)) fail('a maya-owned agent leaf lacks the owner badge');
  }
  // dana parents her one bot
  const d = parent('dana');
  if (!d || JSON.stringify(kidNames(d)) !== JSON.stringify(['danabot'])) fail('dana kids = ' + JSON.stringify(kidNames(d)) + ', want danabot');
  // ownerless agent sits under the "unowned agents" node, no badge
  const u = rows.find((r) => r.label && /unowned agents/i.test(r.name));
  if (!u) fail('"unowned agents" node missing: ' + JSON.stringify(rows.map((r) => r.name)));
  else {
    if (JSON.stringify(kidNames(u)) !== JSON.stringify(['lonerbot'])) fail('unowned kids = ' + JSON.stringify(kidNames(u)) + ', want lonerbot');
    if (u.kids.some((k) => k.badge)) fail('ownerless agent unexpectedly shows an owner badge');
  }
  // agent rows sit 16-20px right of the owner's dot, behind a thin guide line
  const indent = await page.evaluate(() => {
    const lis = [...document.querySelectorAll('#participant-list li')];
    const i = lis.findIndex((li) => li.querySelector('.pname')?.textContent === 'maya');
    const leaf = lis.slice(i + 1).find((li) => li.classList.contains('participant-leaf'));
    const dot = (li) => li.querySelector('.dot, .pdot, .status-dot, [class*="dot"]');
    const ox = dot(lis[i]).getBoundingClientRect().left, lx = dot(leaf).getBoundingClientRect().left;
    const cs = getComputedStyle(leaf);
    return { offset: lx - ox, ox, lx, leafName: leaf.querySelector('.pname')?.textContent, border: cs.borderLeftWidth + ' ' + cs.borderLeftStyle };
  });
  if (!(indent.offset >= 16 && indent.offset <= 20)) fail('agent row offset from the owner dot is ' + indent.offset + 'px, want 16-20: ' + JSON.stringify(indent));
  if (indent.border !== '1px solid') fail('agent block lacks the guide line: ' + indent.border);
  // an owned agent must never appear as its own top-level parent row
  if (parent('mayabot1') || parent('danabot')) fail('an owned agent rendered as a top-level row, not nested');

  await browser.close();
  if (!process.exitCode) console.log('PARTICIPANTTREE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
