// E2E for the resizable thread panel (FR-E). Drag the divider to widen the
// panel, assert it clamps to 20%-50% of the viewport, persists across reloads,
// and that the 504px default holds until a drag.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/threadresize-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman } = require('./lib/login.js');
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
const widthOf = (page) => page.$eval('#thread-panel', (el) => el.getBoundingClientRect().width);

(async () => {
  const created = await newRoom(SERVER, 'threadresize check');
  const code = created.invite_code, slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'viewer', avatar: '🧑', is_human: true } });
  const sender = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'sender', avatar: '🤖' } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: viewer.token, body: { body: 'resize topic' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: sender.token, body: { body: 'a reply', thread_root_id: root.id } });

  const VW = 1400;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: VW, height: 850 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

    await openAsHuman(page, SERVER, slug, viewer);
  await page.goto(SERVER + '/r/' + slug + '/c/general/t/' + root.id, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#thread-panel:not(.hidden)', { timeout: 6000 });

  // default width is ~504 before any drag
  const def = await widthOf(page);
  if (Math.abs(def - 504) > 3) fail(`default width = ${def}, want ~504`);

  const drag = async (toX) => {
    const h = await page.$eval('#thread-resize', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(toX, h.y, { steps: 12 });
    await page.mouse.up();
  };

  // drag left to widen -> wider than default, still <= 50% of viewport
  await drag(VW * 0.55);
  const wide = await widthOf(page);
  if (wide <= def) fail(`drag left did not widen: ${wide} <= ${def}`);
  if (wide > VW * 0.5 + 2) fail(`width ${wide} exceeds 50% clamp (${VW * 0.5})`);

  // drag far right to shrink -> clamped at >= 20% of viewport
  await drag(VW * 0.95);
  const narrow = await widthOf(page);
  if (narrow < VW * 0.2 - 2) fail(`width ${narrow} below 20% clamp (${VW * 0.2})`);

  // persistence: reload keeps the last width
  const before = await widthOf(page);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.goto(SERVER + '/r/' + slug + '/c/general/t/' + root.id, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#thread-panel:not(.hidden)', { timeout: 6000 });
  const after = await widthOf(page);
  if (Math.abs(after - before) > 3) fail(`width not persisted across reload: ${before} -> ${after}`);

  await browser.close();
  if (!process.exitCode) console.log('THREADRESIZE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
