// E2E for task 25's profile delivery row. A human owner opens their agent's
// profile and sees the per-recipient delivery counts; after the agent polls
// and acks, the row moves to "1 acked"; a plain member sees no row at all.
// Run: NODE_PATH=<puppeteer dir> SERVER=http://localhost:8095 node scripts/deliverystats-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs, call } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || '.';
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

const openProfile = async (page, name) => {
  // owned agents sit collapsed under their owner; expand the owners only when the agent is hidden
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

const deliveryRow = (page) => page.$eval('#profile-delivery', (el) => (el.classList.contains('hidden') ? null : el.textContent));

const closeProfile = async (page) => {
  await page.evaluate(() => document.querySelector('#profile-modal .modal-close, #profile-modal button')?.click());
  await page.waitForSelector('#profile-modal.hidden', { timeout: 4000 }).catch(() => {});
};

(async () => {
  const created = await newRoom(SERVER, 'delivery stats check');
  const slug = created.room.slug;
  const roomCode = created.invite_code;

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => { throw new Error('pageerror ' + e.message); });

  // maya (a human) enters, mints an owner invite; agentbot joins owned by maya
  const maya = await enterAs(page, SERVER, slug, roomCode, 'maya');
  const ownerCode = (await call(SERVER, '/api/v1/invites', { method: 'POST', token: maya, headers: { 'X-Workspace-Slug': slug } })).invite_code;
  const bot = await call(SERVER, '/api/v1/rooms/join', { method: 'POST', body: { invite_code: ownerCode, name: 'agentbot', description: 'agent', avatar: '🤖' } });
  await call(SERVER, '/api/v1/channels/general/messages', { method: 'POST', token: maya, headers: { 'X-Workspace-Slug': slug }, body: { body: '@agentbot hello there' } });
  await page.waitForFunction(() => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('hello there')), { timeout: 8000 });

  // 1. the owner sees the row: one event stored, none delivered yet
  await openProfile(page, 'agentbot');
  await page.waitForFunction(() => !document.querySelector('#profile-delivery').classList.contains('hidden'), { timeout: 4000 });
  let row = await deliveryRow(page);
  console.log('owner row (accepted):', row);
  assert(/0 acked/.test(row) && /0 awaiting ack/.test(row) && /1 queued/.test(row), 'expected 1 queued, got: ' + row);
  assert(/oldest unacked/.test(row), 'oldest unacked missing: ' + row);
  await page.screenshot({ path: OUT + '/deliverystats-accepted.png' });
  await closeProfile(page);

  // 2. the agent polls (delivered) and acks; the row follows
  const ev = await call(SERVER, '/api/v1/events?after=0', { token: bot.token });
  const hit = (ev.events || []).find((e) => e.type === 'message.created' && (e.payload.body || '').includes('hello there'));
  assert(hit, 'agent poll did not return the mention');
  await call(SERVER, '/api/v1/events/' + hit.seq + '/ack', { method: 'POST', token: bot.token });
  await openProfile(page, 'agentbot');
  await page.waitForFunction(() => /1 acked/.test(document.querySelector('#profile-delivery').textContent), { timeout: 4000 });
  row = await deliveryRow(page);
  console.log('owner row (acked):', row);
  assert(/0 awaiting ack/.test(row) && !/oldest unacked/.test(row) && !/queued/.test(row), 'expected 1 acked and nothing pending: ' + row);
  await page.screenshot({ path: OUT + '/deliverystats-acked.png' });
  await closeProfile(page);

  // 3. a plain member (not owner, not admin) sees no row
  const page2 = await browser.newPage();
  await enterAs(page2, SERVER, slug, roomCode, 'viewer');
  await openProfile(page2, 'agentbot');
  await new Promise((r) => setTimeout(r, 800));
  const hiddenRow = await deliveryRow(page2);
  assert(hiddenRow === null, 'a plain member saw the delivery row: ' + hiddenRow);
  // the API agrees: 403 for the stranger
  const me2 = await page2.evaluate(() => localStorage.getItem('agentchat:session'));
  const resp = await fetch(SERVER + '/api/v1/participants/' + bot.participant.id + '/delivery', { headers: { Authorization: 'Bearer ' + me2, 'X-Workspace-Slug': slug } });
  console.log('stranger stats status:', resp.status);
  assert(resp.status === 403, 'stranger expected 403, got ' + resp.status);

  await browser.close();
  console.log('DELIVERYSTATS_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
