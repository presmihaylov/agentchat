// E2E for task 27's UI: an agent's profile lists its capabilities with a
// schema toggle, marks an offline agent "not callable", hides the section
// for agents without any, refreshes on capability.registered, and the
// workspace settings show the MCP endpoint URL with a copy button.
// Run: NODE_PATH=<puppeteer dir> SERVER=http://localhost:8095 node scripts/caps-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs, call, openSettings } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';
require('fs').mkdirSync(OUT, { recursive: true });
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

const openProfile = async (page, name) => {
  await page.evaluate((n) => {
    const shown = [...document.querySelectorAll('#participant-list li .pname')].some((e) => e.textContent === n);
    if (!shown) document.querySelectorAll('#participant-list li .p-toggle').forEach((t) => t.click());
  }, name);
  await page.waitForFunction((n) =>
    [...document.querySelectorAll('#participant-list li .pname')].some((e) => e.textContent === n), { timeout: 4000 }, name);
  await page.evaluate((n) => {
    const li = [...document.querySelectorAll('#participant-list li')].find((x) => (x.querySelector('.pname') || {}).textContent === n);
    li.click();
  }, name);
  await page.waitForSelector('#profile-modal:not(.hidden)', { timeout: 4000 });
};
const closeProfile = async (page) => {
  await page.evaluate(() => document.getElementById('profile-close').click());
  await page.waitForSelector('#profile-modal.hidden', { timeout: 4000 });
};
const capsBox = (page) => page.$eval('#profile-caps', (el) => ({ hidden: el.classList.contains('hidden'), text: el.textContent }));
const waitCaps = (page, shown) => page.waitForFunction((s) =>
  document.getElementById('profile-caps').classList.contains('hidden') !== s, { timeout: 4000 }, shown);

const cap = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } });

(async () => {
  const created = await newRoom(SERVER, 'caps check');
  const slug = created.room.slug;
  const roomCode = created.invite_code;
  const hdr = (token) => ({ token, headers: { 'X-Workspace-Slug': slug } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => { throw new Error('pageerror ' + e.message); });

  const maya = await enterAs(page, SERVER, slug, roomCode, 'maya');
  const worker = await call(SERVER, '/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'worker', description: 'has tools', avatar: '🛠️' } });
  const idle = await call(SERVER, '/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'idle', description: 'no tools', avatar: '💤' } });
  await call(SERVER, '/api/v1/me/capabilities', { method: 'PUT', ...hdr(worker.token), body: { capabilities: [cap('echo', 'echoes the question back'), cap('summarize', 'summarizes a url')] } });
  await page.waitForFunction(() => [...document.querySelectorAll('#participant-list li .pname')].some((e) => e.textContent === 'worker'), { timeout: 8000 });

  // 1. an agent with capabilities: two rows, schema toggle reveals the input schema
  await openProfile(page, 'worker');
  await waitCaps(page, true);
  let box = await capsBox(page);
  console.log('worker caps:', box.text);
  assert(/Capabilities/.test(box.text) && /echo/.test(box.text) && /summarize/.test(box.text), 'rows missing: ' + box.text);
  assert(!/not callable/.test(box.text), 'online agent marked offline: ' + box.text);
  assert(await page.$eval('#profile-caps .cap-schema', (el) => el.classList.contains('hidden')), 'schema shown before toggle');
  await page.evaluate(() => document.querySelector('#profile-caps .cap-schema-toggle').click());
  const schema = await page.$eval('#profile-caps .cap-schema', (el) => (el.classList.contains('hidden') ? null : el.textContent));
  assert(schema && /"required"/.test(schema) && /"q"/.test(schema), 'schema toggle did not reveal the input schema: ' + schema);
  await page.screenshot({ path: OUT + '/caps-profile.png' });

  // 2. a live registration refreshes the open profile
  await call(SERVER, '/api/v1/me/capabilities', { method: 'POST', ...hdr(worker.token), body: { capabilities: [cap('draw', 'draws a diagram')] } });
  await page.waitForFunction(() => /draw/.test(document.getElementById('profile-caps').textContent), { timeout: 8000 });
  await closeProfile(page);

  // 3. an agent without capabilities shows no section
  await openProfile(page, 'idle');
  await new Promise((r) => setTimeout(r, 800));
  box = await capsBox(page);
  assert(box.hidden, 'idle agent shows a capabilities section: ' + box.text);
  await closeProfile(page);

  // 4. offline: listed, marked not callable
  await call(SERVER, '/api/v1/me/offline', { method: 'POST', ...hdr(worker.token) });
  // offline rows hide behind the "offline (n)" divider until it is opened
  await page.waitForFunction(() => [...document.querySelectorAll('#participant-list li.offline-toggle')].some((t) => /offline \(1\)/.test(t.textContent)), { timeout: 8000 });
  await page.evaluate(() => document.querySelectorAll('#participant-list li.offline-toggle').forEach((t) => t.click()));
  await openProfile(page, 'worker');
  await waitCaps(page, true);
  box = await capsBox(page);
  console.log('offline caps:', box.text);
  assert(/not callable: offline/.test(box.text) && /echo/.test(box.text), 'offline marker missing: ' + box.text);
  await page.screenshot({ path: OUT + '/caps-profile-offline.png' });
  await closeProfile(page);

  // 5. settings > workspace: the MCP endpoint URL and a copy button, no token anywhere
  await openSettings(page, SERVER, 'workspace');
  await page.waitForFunction(() => (document.getElementById('ws-mcp') || {}).value, { timeout: 8000 });
  const url = await page.$eval('#ws-mcp', (el) => el.value);
  console.log('mcp url:', url);
  assert(url === SERVER + '/api/v1/w/' + slug + '/mcp', 'wrong MCP URL: ' + url);
  const panel = await page.$eval('#ws-mcp', (el) => el.closest('.settings-panel').textContent);
  assert(/Bearer token of an agent or a session/.test(panel), 'hint missing');
  assert(!/act_|ses_/.test(panel), 'a token leaked into the settings panel');
  assert(await page.$('#ws-mcp-copy'), 'copy button missing');
  await page.evaluate(() => document.getElementById('ws-mcp').scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: OUT + '/caps-settings-mcp.png' });

  // the URL really is the MCP endpoint: tools/list through it names worker's tools once it is back online
  await call(SERVER, '/api/v1/participants', { ...hdr(worker.token) }); // any authed call marks worker online again
  const rpc = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idle.token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((r) => r.json());
  const names = (rpc.result.tools || []).map((t) => t.name).sort();
  console.log('tools/list:', names.join(','));
  assert(names.join(',') === 'worker__draw,worker__echo,worker__summarize', 'tools/list mismatch: ' + names.join(','));

  await browser.close();
  console.log('CAPS_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
