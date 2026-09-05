// E2E: everything that happens to my channel list reaches the open web UI over
// the event stream, no reload. bob's page sits in its long poll while alice
// (via the API) creates a public channel, adds bob to a private one, posts in
// it, removes him again, and bob leaves a channel from "another tab".
// Run: NODE_PATH=<puppeteer dir> SERVER=http://localhost:8095 node scripts/channeladd-check.js
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

// the name sits in .chan-name; the sigil (# or the lock) is a separate span
const chanNames = (page) => page.$$eval('#channel-list li', (lis) =>
  lis.map((li) => (li.querySelector('.chan-name') || {}).textContent || ''));
const waitSidebar = (page, pred, what) => page.waitForFunction((src) => {
  const names = [...document.querySelectorAll('#channel-list li')].map((li) => (li.querySelector('.chan-name') || {}).textContent || '');
  return new Function('names', 'return ' + src)(names);
}, { timeout: 5000 }, pred).catch(() => { throw new Error('sidebar never ' + what); });

(async () => {
  const created = await newRoom(SERVER, 'channel add check');
  const slug = created.room.slug, code = created.invite_code;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'bob', is_human: true } });
  await api('/api/v1/channels', { method: 'POST', body: { name: 'vault', private: true }, token: alice.token });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 850 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });

    await openAsHuman(page, SERVER, slug, bob);
  await page.waitForSelector('#channel-list li', { timeout: 6000 });
  let names = await chanNames(page);
  if (names.includes('vault')) throw new Error('private #vault leaked before add: ' + JSON.stringify(names));
  // park the page in its long poll before anything happens
  await new Promise((r) => setTimeout(r, 800));

  // 1. added to a private channel by someone else: appears, unread once posted in
  await api('/api/v1/channels/vault/members', { method: 'POST', body: { participant: 'bob' }, token: alice.token });
  await waitSidebar(page, "names.includes('vault')", 'showed #vault after the add');
  await api('/api/v1/channels/vault/messages', { method: 'POST', body: { body: 'welcome bob' }, token: alice.token });
  await page.waitForFunction(() => [...document.querySelectorAll('#channel-list li')]
    .some((li) => /vault/.test(li.textContent) && li.classList.contains('unread')), { timeout: 5000 })
    .catch(() => { throw new Error('#vault never went unread after a post'); });

  // 2. a public channel created by someone else: joinable in an already-open Browse
  await page.click('#browse-channels');
  await page.waitForSelector('#browse-modal:not(.hidden)', { timeout: 4000 });
  await api('/api/v1/channels', { method: 'POST', body: { name: 'plaza' }, token: alice.token });
  await page.waitForFunction(() => [...document.querySelectorAll('.browse-row .browse-name')]
    .some((n) => n.textContent === '#plaza'), { timeout: 5000 })
    .catch(() => { throw new Error('open Browse never listed #plaza'); });
  await page.click('#browse-close');

  // 3. removed from the private channel by someone else: disappears
  await api('/api/v1/channels/vault/members/bob', { method: 'DELETE', token: alice.token });
  await waitSidebar(page, "!names.includes('vault')", 'dropped #vault after the removal');

  // 4. leaving in another tab (same token, via the API): disappears here too
  await api('/api/v1/channels/plaza/join', { method: 'POST', token: bob.token });
  await waitSidebar(page, "names.includes('plaza')", 'showed #plaza after the join');
  const plaza = (await api('/api/v1/channels', { token: bob.token })).channels.find((c) => c.name === 'plaza');
  await api('/api/v1/channels/' + plaza.id + '/leave', { method: 'POST', token: bob.token });
  await waitSidebar(page, "!names.includes('plaza')", 'dropped #plaza after leaving elsewhere');

  await browser.close();
  console.log('CHANNELADD_CHECK_OK');
})().catch((e) => { console.error('CHANNELADD_CHECK_FAIL', e.message); process.exit(1); });
