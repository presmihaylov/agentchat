// E2E for channel sections and their drag order (task 28). alice has four
// channels. She makes a "Work" section, drags a channel into it, reorders
// inside it, and reorders inside the default "Channels" section. Both orders
// survive a reload, because both live server-side per participant. bob, in the
// same workspace, keeps his own untouched order. Deleting a section drops its
// channels back into the default one, after what is already there, instead of
// losing them.
// Run: NODE_PATH=scripts/node_modules SERVER=http://localhost:8095 node scripts/channelsections-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';
require('fs').mkdirSync(OUT, { recursive: true });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let step = 'setup';

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

// each human gets its own browser context: a second login in the same context
// would overwrite the first one's session for this origin
const openAs = async (browser, slug, joined) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await openAsHuman(page, SERVER, slug, joined);
  await page.waitForSelector('#channel-list li', { timeout: 6000 });
  return page;
};

// the sidebar as sections: [{name, channels:[...]}], default section first
const layout = (page) => page.evaluate(() => {
  const out = [];
  document.querySelectorAll('#channel-list li').forEach((li) => {
    if (li.classList.contains('section-header')) {
      out.push({ name: li.querySelector('.sec-name').textContent, channels: [] });
      return;
    }
    const n = li.querySelector('.chan-name');
    if (n && out.length) out[out.length - 1].channels.push(n.textContent);
  });
  return out;
});
const sectionNamed = async (page, name) => (await layout(page)).find((s) => s.name === name);
const order = async (page, name) => ((await sectionNamed(page, name)) || { channels: [] }).channels.join(',');
const waitOrder = (page, name, want) => page.waitForFunction((n, w) => {
  const out = [];
  document.querySelectorAll('#channel-list li').forEach((li) => {
    if (li.classList.contains('section-header')) { out.push({ name: li.querySelector('.sec-name').textContent, channels: [] }); return; }
    const c = li.querySelector('.chan-name');
    if (c && out.length) out[out.length - 1].channels.push(c.textContent);
  });
  const s = out.find((x) => x.name === n);
  return s && s.channels.join(',') === w;
}, { timeout: 8000 }, name, want);

// the row handlers read clientY and the dragged row, so the real DragEvents do
const dragOnto = (page, from, to, edge) => page.evaluate((f, t, e) => {
  const row = (n) => [...document.querySelectorAll('#channel-list li')]
    .find((li) => !li.classList.contains('section-header') && (li.querySelector('.chan-name') || {}).textContent === n);
  const src = row(f), dst = row(t);
  if (!src || !dst) throw new Error('missing row: ' + f + ' -> ' + t);
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = dst.getBoundingClientRect();
  const y = e === 'top' ? r.top + 2 : r.bottom - 2;
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: r.left + 10, clientY: y }));
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: r.left + 10, clientY: y }));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
}, from, to, edge);

// dropping on a section header appends to that section
const dragOntoHeader = (page, from, section) => page.evaluate((f, s) => {
  const src = [...document.querySelectorAll('#channel-list li')]
    .find((li) => !li.classList.contains('section-header') && (li.querySelector('.chan-name') || {}).textContent === f);
  const head = [...document.querySelectorAll('#channel-list li.section-header')]
    .find((li) => li.querySelector('.sec-name').textContent === s);
  if (!src || !head) throw new Error('missing ' + f + ' or section ' + s);
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = head.getBoundingClientRect();
  head.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 2 }));
  head.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 2 }));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
}, from, section);

// the drag lands the row first and confirms with the writes after, so anything
// that reloads must wait for the server to actually hold the new order
const waitServer = async (token, names, want) => {
  for (let i = 0; i < 40; i += 1) {
    const l = await api('/api/v1/channel-groups', { token });
    const ids = want.section ? (l.groups.find((g) => g.name === want.section) || { channel_ids: [] }).channel_ids : l.ungrouped;
    if (ids.map((id) => names[id]).join(',') === want.order) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server never held ' + JSON.stringify(want));
};

const rightClickChannel = (page, name) => page.evaluate((n) => {
  const li = [...document.querySelectorAll('#channel-list li')]
    .find((l) => !l.classList.contains('section-header') && (l.querySelector('.chan-name') || {}).textContent === n);
  if (!li) throw new Error('no channel row for ' + n);
  li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
}, name);
const clickMenuItem = (page, label) => page.evaluate((l) => {
  const item = [...document.querySelectorAll('div,li,button,span')].find((e) => e.textContent.trim() === l && e.children.length === 0);
  if (!item) throw new Error('no menu item: ' + l);
  item.click();
}, label);

(async () => {
  const created = await newRoom(SERVER, 'sections check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'bob', is_human: true } });
  for (const name of ['alpha', 'beta', 'gamma']) {
    const ch = await api('/api/v1/channels', { method: 'POST', body: { name }, token: alice.token });
    await api('/api/v1/channels/' + ch.id + '/join', { method: 'POST', token: bob.token });
  }

  const names = {};
  (await api('/api/v1/channels', { token: alice.token })).channels.forEach((c) => { names[c.id] = c.name; });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ap = await openAs(browser, slug, alice);
  ap.on('dialog', async (d) => d.accept(/section name/i.test(d.message()) ? 'Work' : ''));

  step = '1 default section exists';
  // 1. the default section is a real section, and it holds everything
  await ap.waitForFunction(() => document.querySelector('#channel-list li.section-header.default-section'), { timeout: 6000 });
  const start = await layout(ap);
  assert(start[0].name === 'Channels', 'the first section is not the default one: ' + JSON.stringify(start));
  const baseline = start[0].channels.join(',');
  assert(/general/.test(baseline) && /alpha/.test(baseline) && /gamma/.test(baseline), 'default section: ' + baseline);
  await ap.screenshot({ path: OUT + '/sections-start.png' });

  step = '2 reorder in default';
  // 2. reorder INSIDE the default section: gamma to the top
  await dragOnto(ap, 'gamma', start[0].channels[0], 'top');
  await waitOrder(ap, 'Channels', ['gamma'].concat(start[0].channels.filter((c) => c !== 'gamma')).join(','));

  step = '3 create Work and move in';
  // 3. a new "Work" section, then drag beta into it
  await rightClickChannel(ap, 'alpha');
  await clickMenuItem(ap, 'Move to section…');
  await clickMenuItem(ap, 'New section…');
  step = '3a Work header appears';
  await ap.waitForFunction(() => [...document.querySelectorAll('#channel-list li.section-header .sec-name')].some((e) => e.textContent === 'Work'), { timeout: 6000 });
  step = '3b alpha lands in Work';
  await waitOrder(ap, 'Work', 'alpha');
  step = '3c beta dragged into Work';
  await dragOntoHeader(ap, 'beta', 'Work');
  await waitOrder(ap, 'Work', 'alpha,beta');
  // alpha and beta left the default section, so its expected order shrinks
  const wantDefault = start[0].channels.filter((c) => c !== 'alpha' && c !== 'beta');
  wantDefault.unshift(wantDefault.splice(wantDefault.indexOf('gamma'), 1)[0]);
  const wantDefaultStr = wantDefault.join(',');
  await waitOrder(ap, 'Channels', wantDefaultStr);
  await ap.screenshot({ path: OUT + '/sections-moved.png' });

  step = '4 reorder in Work';
  // 4. reorder INSIDE "Work": beta above alpha
  await dragOnto(ap, 'beta', 'alpha', 'top');
  await waitOrder(ap, 'Work', 'beta,alpha');
  await waitServer(alice.token, names, { section: 'Work', order: 'beta,alpha' });
  await waitServer(alice.token, names, { order: wantDefaultStr });

  step = '5 reload keeps both orders';
  // 5. both orders survive a reload, so both are server-side
  await ap.reload({ waitUntil: 'networkidle2' });
  await ap.waitForSelector('#channel-list li.section-header', { timeout: 8000 });
  await waitOrder(ap, 'Work', 'beta,alpha');
  await waitOrder(ap, 'Channels', wantDefaultStr);
  await ap.screenshot({ path: OUT + '/sections-reloaded.png' });

  step = '6 default collapse persists';
  // 6. the default section collapses like any other, and that persists too
  await ap.evaluate(() => document.querySelector('#channel-list li.section-header.default-section').click());
  await ap.waitForFunction(() => document.querySelector('#channel-list li.section-header.default-section').classList.contains('collapsed'), { timeout: 6000 });
  await ap.reload({ waitUntil: 'networkidle2' });
  await ap.waitForFunction(() => {
    const h = document.querySelector('#channel-list li.section-header.default-section');
    return h && h.classList.contains('collapsed');
  }, { timeout: 8000 });
  await ap.evaluate(() => document.querySelector('#channel-list li.section-header.default-section').click());
  await waitOrder(ap, 'Channels', wantDefaultStr);

  step = '7 bob unaffected';
  // 7. bob is untouched: no "Work", and his own default order is the natural one
  const bp = await openAs(browser, slug, bob);
  const bl = await layout(bp);
  assert(!bl.some((s) => s.name === 'Work'), 'bob sees alice section: ' + JSON.stringify(bl));
  assert(bl[0].channels.join(',') !== wantDefaultStr, 'bob inherited alice order: ' + bl[0].channels.join(','));
  assert(bl[0].channels.includes('beta'), 'beta left bob default section: ' + bl[0].channels.join(','));

  step = '8 delete section returns channels';
  // 8. deleting a section returns its channels to the default one, appended
  // after everything already there. delta is created now and never dragged, so
  // it has no placement row: only the client knows it belongs before beta,alpha.
  step = '8-delta';
  const delta = await api('/api/v1/channels', { method: 'POST', body: { name: 'delta' }, token: alice.token });
  names[delta.id] = 'delta';
  await waitOrder(ap, 'Channels', wantDefaultStr + ',delta');
  step = '8-delete';
  await ap.evaluate(() => {
    const h = [...document.querySelectorAll('#channel-list li.section-header')].find((e) => (e.querySelector('.sec-name') || {}).textContent === 'Work');
    h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
  });
  await clickMenuItem(ap, 'Delete section');
  await waitOrder(ap, 'Channels', wantDefaultStr + ',delta,beta,alpha');
  await waitServer(alice.token, names, { order: wantDefaultStr + ',delta,beta,alpha' });
  await ap.reload({ waitUntil: 'networkidle2' });
  await ap.waitForSelector('#channel-list li.section-header', { timeout: 8000 });
  await waitOrder(ap, 'Channels', wantDefaultStr + ',delta,beta,alpha');

  await browser.close();
  console.log('CHANNELSECTIONS_CHECK_OK');
})().catch((e) => { console.error('CHANNELSECTIONS_CHECK_FAIL at step [' + step + ']:', e.message); process.exit(1); });
