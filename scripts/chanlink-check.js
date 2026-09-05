require('fs').mkdirSync(process.env.OUT || 'tmp', { recursive: true });
// E2E for #channel mentions: "#name" renders as an in-app link for a channel
// you are in, stays plain text for one you are not (a private channel leaks
// nothing), and "#" opens a channel autocomplete in both composers.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/chanlink-check.js
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
  const created = await newRoom(SERVER, 'chanlink check');
  const slug = created.room.slug;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'alice', is_human: true } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'bob', is_human: true } });
  await api('/api/v1/channels', { method: 'POST', token: alice.token, body: { name: 'plaza', topic: 'town square' } });
  await api('/api/v1/channels', { method: 'POST', token: alice.token, body: { name: 'vault', private: true } });
  // bob is in general only; plaza is public, vault is private and alice-only
  const root = await api('/api/v1/channels/general/messages', {
    method: 'POST', token: alice.token, body: { body: 'see #plaza and #vault, not #nowhere or PR #10020' },
  });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const login = async (joined) => {
    await openAsHuman(page, SERVER, slug, joined);
    await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
    await page.waitForFunction((id) => !!document.querySelector('#messages .msg[data-id="' + id + '"]'), { timeout: 8000 }, root.id);
  };
  const linksIn = (id) => page.evaluate((id) => {
    const el = document.querySelector('#messages .msg[data-id="' + id + '"]');
    return {
      links: [...el.querySelectorAll('a.chanlink')].map((a) => a.textContent + '|' + a.getAttribute('href')),
      text: el.textContent,
    };
  }, id);

  // 1. alice is in every channel: both real names link, the rest stay text
  await login(alice);
  let got = await linksIn(root.id);
  assert(got.links.join(',') === '#plaza|/r/' + slug + '/c/plaza,#vault|/r/' + slug + '/c/vault',
    'alice links: ' + JSON.stringify(got));
  assert(/#nowhere/.test(got.text) && /#10020/.test(got.text), 'plain text lost: ' + got.text);

  // 2. clicking a link navigates in-app: no reload, URL follows
  await page.evaluate(() => { window.__stay = true; });
  await page.click('#messages a.chanlink');
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('plaza'), { timeout: 8000 });
  assert(await page.evaluate(() => window.__stay === true), 'the #channel link reloaded the page');
  assert((await page.evaluate(() => location.pathname)) === '/r/' + slug + '/c/plaza', 'URL did not follow the link');

  // 3. "#" completes channels in the root composer; Enter inserts "#name "
  await page.focus('#composer-input');
  await page.type('#composer-input', 'go to #pl');
  const ac = '.chan-ac:not(.hidden)';
  await page.waitForSelector(ac, { timeout: 5000 });
  const opts = await page.$$eval(ac + ' .mention-opt', (ns) => ns.map((n) => n.textContent));
  assert(opts.length === 1 && /^#plaza/.test(opts[0]) && /town square/.test(opts[0]), 'popup options: ' + JSON.stringify(opts));
  await page.keyboard.press('Enter');
  const typed = await page.$eval('#composer-input', (el) => el.value);
  assert(typed === 'go to #plaza ', 'inserted text: ' + JSON.stringify(typed));
  assert(await page.$('#composer-input .chanlink'), 'no #channel chip in the composer');
  await page.screenshot({ path: (process.env.OUT || 'tmp') + '/chanlink-composer.png' });
  await page.$eval('#composer-input', (el) => el.__composer.clear());

  // 4. the thread composer does the same
  await page.evaluate(() => [...document.querySelectorAll('#channel-list li')]
    .find((li) => /general/.test(li.textContent)).click());
  await page.waitForFunction((id) => !!document.querySelector('#messages .msg[data-id="' + id + '"] [data-act="thread"]'), { timeout: 8000 }, root.id);
  await page.evaluate((id) => document.querySelector('#messages .msg[data-id="' + id + '"] [data-act="thread"]').click(), root.id);
  await page.waitForSelector('#thread-panel:not(.hidden)', { timeout: 8000 });
  await page.focus('#thread-input');
  await page.type('#thread-input', '#va');
  await page.waitForSelector(ac, { timeout: 5000 });
  const topts = await page.$$eval(ac + ' .mention-opt', (ns) => ns.map((n) => n.textContent));
  assert(topts.length === 1 && /vault/.test(topts[0]), 'thread popup options: ' + JSON.stringify(topts));
  await page.keyboard.press('Enter');
  const treply = await page.$eval('#thread-input', (el) => el.value);
  assert(treply === '#vault ', 'thread inserted text: ' + JSON.stringify(treply));
  await page.$eval('#thread-input', (el) => el.__composer.clear());

  // 5. bob is in neither: public #plaza still links, private #vault stays plain
  //    text and never appears in the popup
  await login(bob);
  got = await linksIn(root.id);
  assert(got.links.join(',') === '#plaza|/r/' + slug + '/c/plaza', 'bob links: ' + JSON.stringify(got));
  await page.focus('#composer-input');
  await page.type('#composer-input', '#');
  await page.waitForSelector(ac, { timeout: 5000 });
  const bopts = await page.$$eval(ac + ' .mention-opt', (ns) => ns.map((n) => n.textContent));
  assert(!bopts.some((o) => /vault/.test(o)), 'a private channel leaked into the popup: ' + JSON.stringify(bopts));
  assert(bopts.some((o) => /general/.test(o)), 'general missing from the popup: ' + JSON.stringify(bopts));
  assert(bopts.some((o) => /plaza.*not joined/.test(o)), 'public channel not offered: ' + JSON.stringify(bopts));
  await page.keyboard.press('Escape');
  await page.$eval('#composer-input', (el) => el.__composer.clear());

  // 6. clicking a public #channel you are not in joins it and opens it
  await page.click('#messages a.chanlink');
  await page.waitForFunction(() => document.querySelector('#channel-title').textContent.includes('plaza'), { timeout: 8000 });
  const bobChans = (await api('/api/v1/channels', { token: bob.token })).channels.map((c) => c.name);
  assert(bobChans.includes('plaza'), 'the link did not join plaza: ' + JSON.stringify(bobChans));

  await browser.close();
  console.log('CHANLINK_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
