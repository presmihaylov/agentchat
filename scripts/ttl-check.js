require('fs').mkdirSync(process.env.OUT || 'tmp', { recursive: true });
// E2E for workspace and channel expiry (task 26): an admin sets a workspace
// expiry from Settings → Workspace and sees the pill; a channel expiry shows a
// pill in the title and the sidebar menu offers extend/remove; once a channel
// is past its expiry (backdated with psql) the composer locks and the server
// answers 409; the same for the workspace; extending it revives both.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/ttl-check.js
const puppeteer = require('puppeteer-core');
const path = require('path');
const { execFileSync } = require('child_process');
const { newRoom, openAsHuman, openSettings, backToRoom, sleep } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';
const DB_URL = process.env.AGENTCHAT_DB_URL || 'postgres://agentchat:agentchat@localhost:5477/agentchat?sslmode=disable';

const psql = (sql) => execFileSync('psql', [DB_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'ignore', 'inherit'] });

async function api(p, opts = {}) {
  const resp = await fetch(SERVER + p, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}
const must = async (p, opts) => { const r = await api(p, opts); if (r.status >= 400) throw new Error(p + ' -> ' + r.status + ' ' + JSON.stringify(r.data)); return r.data; };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const menuItems = (page) => page.evaluate(() => [...document.querySelectorAll('.context-menu *')].filter((e) => e.children.length === 0).map((e) => e.textContent.trim()));
const openChanMenu = (page, name) => page.evaluate((n) => {
  const li = [...document.querySelectorAll('#channel-list li')].find((l) => ((l.querySelector('.chan-name') || {}).textContent || '').startsWith(n));
  li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
}, name);
const clickChannel = (page, name) => page.evaluate((n) => {
  const li = [...document.querySelectorAll('#channel-list li')].find((l) => ((l.querySelector('.chan-name') || {}).textContent || '').startsWith(n));
  li.click();
}, name);
const composerLocked = (page) => page.$eval('#composer', (el) => el.classList.contains('locked'));
const lockText = (page) => page.$eval('#composer-lock', (el) => el.textContent.trim());

(async () => {
  const created = await newRoom(SERVER, 'ttl check');
  const slug = created.room.slug;
  const roomID = created.room.id;
  const alice = await must('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'alice', is_human: true } });
  const ops = await must('/api/v1/channels', { method: 'POST', token: alice.token, body: { name: 'ops', expiresInSeconds: 3600 } });
  assert(ops.expires_at && !ops.expired, 'ops created with an expiry: ' + JSON.stringify(ops));
  await must('/api/v1/channels/' + ops.id + '/messages', { method: 'POST', token: alice.token, body: { body: 'before the expiry' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  let step = 'boot';
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await openAsHuman(page, SERVER, slug, alice);
    await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

    step = 'no workspace pill yet';
    assert(await page.$eval('#room-expiry', (el) => el.classList.contains('hidden')), 'room pill hidden with no expiry');

    step = 'channel pill + menu';
    await clickChannel(page, 'ops');
    await page.waitForFunction(() => /Expires in/.test((document.querySelector('#channel-expiry') || {}).textContent || ''), { polling: 200, timeout: 8000 });
    await openChanMenu(page, 'ops');
    let items = await menuItems(page);
    assert(items.includes('Extend expiry by 24h') && items.includes('Remove expiry'), 'admin menu offers extend/remove: ' + JSON.stringify(items));
    await page.screenshot({ path: path.join(OUT, 'ttl-channel-menu.png') });
    await page.keyboard.press('Escape');
    await openChanMenu(page, 'general');
    items = await menuItems(page);
    assert(!items.some((t) => /expiry/i.test(t)), '#general has no expiry items: ' + JSON.stringify(items));
    await page.keyboard.press('Escape');

    step = 'channel expires: composer locks';
    psql(`UPDATE channels SET expires_at = now() - interval '1 minute' WHERE id = '${ops.id}'`);
    // the sweeper runs every 60s; the event flips the UI without a reload
    await page.waitForFunction(() => document.querySelector('#composer').classList.contains('locked'), { polling: 500, timeout: 90000 });
    assert(/channel expired/.test(await lockText(page)), 'lock text names the channel: ' + await lockText(page));
    assert(await page.$eval('#channel-expiry', (el) => el.classList.contains('expired') && /read-only/.test(el.textContent)), 'channel pill turned red');
    await page.screenshot({ path: path.join(OUT, 'ttl-channel-expired.png') });
    let r = await api('/api/v1/channels/' + ops.id + '/messages', { method: 'POST', token: alice.token, body: { body: 'too late' } });
    assert(r.status === 409 && r.data.code === 'channel_expired', 'post on expired channel: ' + r.status + ' ' + JSON.stringify(r.data));
    await clickChannel(page, 'general');
    await page.waitForFunction(() => !document.querySelector('#composer').classList.contains('locked'), { polling: 200, timeout: 8000 });

    step = 'channel revive from the menu';
    await openChanMenu(page, 'ops');
    await page.evaluate(() => [...document.querySelectorAll('.context-menu *')].find((e) => e.textContent.trim() === 'Remove expiry').click());
    await page.waitForFunction(() => !document.querySelector('#channel-expiry'), { polling: 200, timeout: 8000 });
    await clickChannel(page, 'ops');
    await page.waitForFunction(() => !document.querySelector('#composer').classList.contains('locked'), { polling: 200, timeout: 8000 });
    await must('/api/v1/channels/' + ops.id + '/messages', { method: 'POST', token: alice.token, body: { body: 'after the revive' } });

    step = 'workspace expiry from settings';
    await openSettings(page, SERVER, 'workspace');
    await page.waitForSelector('#ws-expiry-actions:not(.hidden)', { timeout: 8000 });
    assert(/No expiry/.test(await page.$eval('#ws-expiry-state', (el) => el.textContent)), 'state says no expiry');
    await page.select('#ws-expiry-by', '86400');
    await page.click('#ws-expiry-apply');
    await page.waitForFunction(() => /^Expires /.test(document.getElementById('ws-expiry-state').textContent), { polling: 200, timeout: 8000 });
    assert(!(await page.$eval('#ws-expiry-clear', (el) => el.classList.contains('hidden'))), 'remove button appears');
    await page.screenshot({ path: path.join(OUT, 'ttl-settings.png') });
    await backToRoom(page);
    await page.waitForFunction(() => /Expires in/.test(document.getElementById('room-expiry').textContent), { polling: 200, timeout: 8000 });
    assert(/general/.test(await page.$eval('#room-expiry', (el) => el.textContent)) === false, 'room pill has the countdown');

    step = 'workspace expires: everything locks';
    psql(`UPDATE rooms SET expires_at = now() - interval '1 minute' WHERE id = '${roomID}'`);
    await page.waitForFunction(() => document.querySelector('#composer').classList.contains('locked'), { polling: 500, timeout: 90000 });
    assert(/workspace expired/.test(await lockText(page)), 'lock text names the workspace: ' + await lockText(page));
    assert(await page.$eval('#room-expiry', (el) => el.classList.contains('expired') && /deleted in/.test(el.textContent)), 'room pill says deleted in');
    await page.screenshot({ path: path.join(OUT, 'ttl-workspace-expired.png') });
    r = await api('/api/v1/channels/general/messages', { method: 'POST', token: alice.token, body: { body: 'too late' } });
    assert(r.status === 409 && r.data.code === 'workspace_expired', 'post on expired workspace: ' + r.status + ' ' + JSON.stringify(r.data));
    r = await api('/api/v1/channels/general/messages?limit=5', { token: alice.token });
    assert(r.status === 200, 'reads still work: ' + r.status);

    step = 'workspace revive from settings';
    await openSettings(page, SERVER, 'workspace');
    await page.waitForSelector('#ws-expiry-actions:not(.hidden)', { timeout: 8000 });
    assert(/^Expired /.test(await page.$eval('#ws-expiry-state', (el) => el.textContent)), 'settings say expired');
    await page.click('#ws-expiry-clear');
    await page.waitForFunction(() => /No expiry/.test(document.getElementById('ws-expiry-state').textContent), { polling: 200, timeout: 8000 });
    await backToRoom(page);
    await page.waitForFunction(() => !document.querySelector('#composer').classList.contains('locked') && document.getElementById('room-expiry').classList.contains('hidden'), { polling: 200, timeout: 8000 });
    await must('/api/v1/channels/general/messages', { method: 'POST', token: alice.token, body: { body: 'revived' } });

    step = 'member sees state, no controls';
    const bob = await must('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'bob', is_human: true } });
    await sleep(500);
    const ctx = await browser.createBrowserContext();
    const pageB = await ctx.newPage();
    await pageB.setViewport({ width: 1280, height: 800 });
    await openAsHuman(pageB, SERVER, slug, bob);
    await pageB.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
    await openSettings(pageB, SERVER, 'workspace');
    await pageB.waitForFunction(() => /No expiry/.test(document.getElementById('ws-expiry-state').textContent), { polling: 200, timeout: 8000 });
    assert(await pageB.$eval('#ws-expiry-actions', (el) => el.classList.contains('hidden')), 'member has no expiry controls');
    r = await api('/api/v1/room', { method: 'PATCH', token: bob.token, body: { expiresInSeconds: 3600 } });
    assert(r.status === 403, 'member cannot set the expiry over the API: ' + r.status);

    console.log('TTL_CHECK_OK');
  } catch (e) {
    console.error('FAILED at step: ' + step);
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
