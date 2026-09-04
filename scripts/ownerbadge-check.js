// E2E: owner-avatar badge. An agent with a server-verified owner shows the
// owner's avatar as a small badge (bottom-right) on its own avatar, in message
// headers and the participant list. Humans and ownerless agents render no badge.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/ownerbadge-check.js
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

(async () => {
  const created = await newRoom(SERVER, 'ownerbadge check');
  const roomCode = created.invite_code;
  const slug = created.room.slug;

  // human owner joins with the room code (no owner of their own)
  const maya = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'maya', description: 'human', avatar: '🧑', is_human: true } });
  // maya mints a personal (owner-scoped) invite; an agent joining with it is owned by maya
  const ownerCode = (await api('/api/v1/invites', { method: 'POST', token: maya.token })).invite_code;
  const owned = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: ownerCode, name: 'ownedbot', description: 'agent', avatar: '🤖' } });
  // an ownerless agent joins with the plain room code
  const loner = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: roomCode, name: 'lonerbot', description: 'agent', avatar: '👽' } });

  // each posts so all three avatars render in the message list
  await api('/api/v1/channels/general/messages', { method: 'POST', token: owned.token, body: { body: 'from owned agent' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: loner.token, body: { body: 'from ownerless agent' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: maya.token, body: { body: 'from human' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  await enterAs(page, SERVER, slug, roomCode, 'viewer');
  await page.waitForSelector('.msg', { timeout: 8000 });

  // message-header avatars: badge present only for the owned agent
  const byAuthor = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.msg').forEach((m) => {
      const name = m.querySelector('.author')?.textContent;
      if (name) out[name] = !!m.querySelector('.avatar .owner-badge-av');
    });
    return out;
  });
  if (byAuthor.ownedbot !== true) fail('owned agent message avatar has no owner badge: ' + JSON.stringify(byAuthor));
  if (byAuthor.lonerbot !== false) fail('ownerless agent message avatar unexpectedly has a badge');
  if (byAuthor.maya !== false) fail('human message avatar unexpectedly has a badge');

  // humans collapse their agents by default; expand maya to reveal ownedbot
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#participant-list li')].find((x) => (x.querySelector('.pname') || {}).textContent === 'maya');
    if (li) (li.querySelector('.p-toggle') || li).click();
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#participant-list li .pname')].some((e) => e.textContent === 'ownedbot'),
    { timeout: 4000 });

  // participant list: same rule
  const byPart = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#participant-list li').forEach((li) => {
      const name = li.querySelector('.pname')?.textContent;
      if (name) out[name] = !!li.querySelector('.owner-badge-av');
    });
    return out;
  });
  if (byPart.ownedbot !== true) fail('owned agent participant row has no owner badge: ' + JSON.stringify(byPart));
  if (byPart.lonerbot !== false) fail('ownerless agent participant row unexpectedly has a badge');
  if (byPart.maya !== false) fail('human participant row unexpectedly has a badge');

  // the badge shows the OWNER's emoji, not the agent's
  const badgeText = await page.evaluate(() =>
    document.querySelector('#participant-list li .owner-badge-av')?.textContent || '');
  if (badgeText !== '🧑') fail("owner badge shows wrong avatar, want owner's 🧑, got: " + JSON.stringify(badgeText));

  await browser.close();
  if (!process.exitCode) console.log('OWNERBADGE_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
