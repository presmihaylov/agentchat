require('fs').mkdirSync(process.env.OUT || 'tmp', { recursive: true });
// E2E for dragging channels between sidebar sections: a real browser drag lands
// the row, the order inside a section survives a reload, a collapsed section
// accepts a drop on its header, and the strip drops a channel out of sections.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/dnd-check.js
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
  if (resp.status >= 400) throw new Error(path + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await newRoom(SERVER, 'dnd check');
  const slug = created.room.slug;
  const me = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', is_human: true } });
  const T = { token: me.token };
  for (const name of ['alpha', 'beta', 'gamma']) {
    await api('/api/v1/channels', { method: 'POST', token: me.token, body: { name } });
  }
  await api('/api/v1/channel-groups', { method: 'POST', token: me.token, body: { name: 'Work' } });
  await api('/api/v1/channel-groups', { method: 'POST', token: me.token, body: { name: 'Ops' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
    await openAsHuman(page, SERVER, slug, me);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  const rows = () => page.$$eval('#channel-list li', (ns) => ns
    .filter((n) => !n.classList.contains('drop-none'))
    .map((n) => (n.classList.contains('section-header') ? '§ ' : '') + n.textContent.trim()));
  const rowHandle = async (label) => {
    const h = (await page.$$('#channel-list li'))
      .map((el, i) => ({ el, i }));
    const texts = await page.$$eval('#channel-list li', (ns) => ns.map((n) => n.textContent.trim()));
    const idx = texts.findIndex((t) => t.toLowerCase().includes(label.toLowerCase()));
    assert(idx >= 0, 'no sidebar row for ' + label + ': ' + JSON.stringify(texts));
    return h[idx].el;
  };
  // Chrome's DevTools drag interception does not fire here, so the drag is
  // driven with the same DragEvents the browser would dispatch on our handlers.
  const dragTo = async (from, to, half) => {
    const ok = await page.evaluate((fromLabel, toLabel, where) => {
      const ns = [...document.querySelectorAll('#channel-list li')];
      const pick = (label) => ns.find((n) => n.textContent.trim().toLowerCase().includes(label.toLowerCase()));
      const src = pick(fromLabel);
      const dst = pick(toLabel);
      if (!src || !dst) return false;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = dst.getBoundingClientRect();
      const y = where === 'top' ? r.top + 2 : where === 'bottom' ? r.bottom - 2 : r.top + r.height / 2;
      const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: y };
      dst.dispatchEvent(new DragEvent('dragover', init));
      dst.dispatchEvent(new DragEvent('drop', init));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return true;
    }, from, to, half || '');
    assert(ok, 'drag ' + from + ' -> ' + to + ' found no row');
  };
  const placement = async () => {
    const g = await api('/api/v1/channel-groups', T);
    const chans = (await api('/api/v1/room', T)).channels;
    const nameOf = (id) => (chans.find((c) => c.id === id) || {}).name;
    return Object.fromEntries(g.groups.map((x) => [x.name, (x.channel_ids || []).map(nameOf)]));
  };

  // the drop persists in the background, so poll instead of racing it
  const expect = async (want, msg) => {
    for (let i = 0; i < 40; i += 1) {
      const p = await placement();
      const got = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.join()]));
      if (Object.entries(want).every(([k, v]) => got[k] === v)) return;
      if (i === 39) throw new Error(msg + ': ' + JSON.stringify(got));
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  // 1. drop a channel onto a section header
  await dragTo('alpha', 'WORK');
  await page.waitForFunction(() => {
    const ns = [...document.querySelectorAll('#channel-list li')];
    const h = ns.findIndex((n) => n.textContent.includes('Work'));
    return h >= 0 && ns[h + 1] && ns[h + 1].textContent.includes('alpha');
  }, { timeout: 8000 });
  await expect({ Work: 'alpha' }, 'alpha did not persist into Work');

  // 2. a second channel, then reorder above the first
  await dragTo('beta', 'WORK');
  await expect({ Work: 'alpha,beta' }, 'Work order before reorder');
  await dragTo('beta', 'alpha', 'top');
  await expect({ Work: 'beta,alpha' }, 'reorder did not persist');

  // the sidebar shows the same order after a reload, not just in memory
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  const after = await rows();
  const w = after.findIndex((t) => t.startsWith('§') && /Work/i.test(t));
  assert(/beta/.test(after[w + 1]) && /alpha/.test(after[w + 2]), 'sidebar order after reload: ' + JSON.stringify(after));

  // 3. a collapsed section still accepts a drop on its header
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li.section-header')]
    .find((n) => /Ops/i.test(n.textContent)).click());
  await page.waitForFunction(() => [...document.querySelectorAll('#channel-list li.section-header')]
    .some((n) => /Ops/i.test(n.textContent) && n.classList.contains('collapsed')), { timeout: 5000 });
  await dragTo('gamma', 'OPS');
  await expect({ Ops: 'gamma' }, 'collapsed drop failed');

  // 4. the strip drops a channel back out of every section
  await dragTo('alpha', 'drop here for no section');
  await expect({ Work: 'beta' }, 'alpha did not leave Work');

  // 5. the mid-drag affordances: lifted row, drop line, sections outlined
  await page.evaluate(() => {
    const ns = [...document.querySelectorAll('#channel-list li')];
    const src = ns.find((n) => n.textContent.includes('beta'));
    const dst = ns.find((n) => n.textContent.includes('alpha'));
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
  });
  await page.screenshot({ path: (process.env.OUT || 'tmp') + '/dnd-dragging.png' });
  const marks = await page.$$eval('#channel-list li', (ns) => ({
    dnd: document.getElementById('channel-list').classList.contains('dnd'),
    lifted: ns.filter((n) => n.classList.contains('dragging')).length,
    line: ns.filter((n) => n.classList.contains('drop-before') || n.classList.contains('drop-after')).length,
  }));
  assert(marks.dnd && marks.lifted === 1 && marks.line === 1, 'drag affordances missing: ' + JSON.stringify(marks));

  await browser.close();
  console.log('DND_CHECK_OK');
})().catch((e) => { console.error('DND_CHECK_FAIL:', e.message); process.exit(1); });
