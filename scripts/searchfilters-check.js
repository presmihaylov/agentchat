// E2E for search filters (task F): From (humans AND agents, with avatars,
// multi-select), In (one channel), Date presets + after/before, Kind, Has
// attachment; active filters as removable chips above the results; inline
// from:/in:/has: tokens lift into chips; everything ANDs into one
// /api/v1/search/hybrid request whose params the page exposes for the check.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/searchfilters-check.js
const puppeteer = require('puppeteer-core');
const fs = require('fs');
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
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const snippets = (page) => page.evaluate(() => [...document.querySelectorAll('#search-results .search-hit-row .sh-snippet')].map((s) => s.textContent));
const chips = (page) => page.evaluate(() => [...document.querySelectorAll('#search-chips .search-chip')].map((c) => c.dataset.filter + '=' + c.querySelector('.chip-val').textContent));
const waitRows = (page, pred, msg) => page.waitForFunction((src) => {
  const f = new Function('rows', 'return (' + src + ')(rows)');
  return f([...document.querySelectorAll('#search-results .search-hit-row .sh-snippet')].map((s) => s.textContent));
}, { timeout: 8000 }, pred.toString()).catch(() => { throw new Error(msg); });
const retype = async (page, q) => { await page.click('#search-input', { clickCount: 3 }); await page.type('#search-input', q); };

(async () => {
  const created = await newRoom(SERVER, 'searchfilters check');
  const slug = created.room.slug;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'alice', description: 't', avatar: '🦊' } });
  const bob = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'bob', description: 't', avatar: '🐻' } });
  const carol = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'carol', is_human: true, avatar: '🧑' } });
  await api('/api/v1/channels', { method: 'POST', token: alice.token, body: { name: 'ops', topic: '' } });
  await api('/api/v1/channels/ops/join', { method: 'POST', token: bob.token });
  await api('/api/v1/channels/ops/join', { method: 'POST', token: carol.token });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: alice.token, body: { body: 'deploy plan alpha' } });
  const bobGen = await api('/api/v1/channels/general/messages', { method: 'POST', token: bob.token, body: { body: 'deploy plan bravo' } });
  await api('/api/v1/channels/ops/messages', { method: 'POST', token: alice.token, body: { body: 'deploy plan charlie' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: carol.token, body: { body: 'deploy plan delta' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: alice.token, body: { body: 'deploy plan echo reply', thread_root_id: bobGen.id } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  const urls = [];
  page.on('request', (req) => { if (req.url().includes('/api/v1/search/hybrid')) urls.push(new URL(req.url())); });
  await openAsHuman(page, SERVER, slug, carol);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 6000 });

  await page.evaluate(() => document.getElementById('open-search').click());
  await page.waitForSelector('#search-modal:not(.hidden)', { timeout: 3000 });
  await page.type('#search-input', 'deploy plan');
  await waitRows(page, (r) => r.length === 5, 'unfiltered query did not return all 5 rows');

  // From: the picker lists humans and agents alike, each with an avatar
  await page.click('#search-filters .sf-btn[data-sf="from"]');
  await page.waitForSelector('#sf-pop:not(.hidden) .sf-opt', { timeout: 3000 });
  const opts = await page.evaluate(() => [...document.querySelectorAll('#sf-pop .sf-opt')].map((o) => ({ label: o.querySelector('.sf-opt-label').textContent, avatar: !!o.querySelector('.avatar-sm') })));
  const names = opts.map((o) => o.label);
  assert(names.some((n) => n.startsWith('carol')) && names.some((n) => n.startsWith('alice') && n.includes('agent')) && names.some((n) => n.startsWith('bob')), 'From picker should list humans and agents: ' + JSON.stringify(names));
  assert(opts.every((o) => o.avatar), 'every From option needs an avatar: ' + JSON.stringify(opts));
  const tick = (label) => page.evaluate((l) => [...document.querySelectorAll('#sf-pop .sf-opt')].find((o) => o.querySelector('.sf-opt-label').textContent.startsWith(l)).querySelector('input').click(), label);
  await tick('alice');
  await waitRows(page, (r) => r.length === 3 && r.every((s) => /alpha|charlie|echo/.test(s)), 'from:alice did not narrow to alice rows');
  await tick('bob'); // multi-select ORs authors
  await waitRows(page, (r) => r.length === 4, 'from alice+bob should show 4 rows');
  assert((await chips(page)).join() === 'from=alice,from=bob', 'chips: ' + (await chips(page)).join());
  const lastURL = () => urls[urls.length - 1];
  assert(lastURL().searchParams.getAll('author').length === 2, 'two author params expected: ' + lastURL().search);

  // In: one channel, ANDed with the author chips
  await page.click('#search-filters .sf-btn[data-sf="in"]');
  await page.waitForSelector('#sf-pop[data-for="in"] .sf-opt', { timeout: 3000 });
  await tick('#ops');
  await waitRows(page, (r) => r.length === 1 && r[0].includes('charlie'), 'from alice+bob AND in:ops should leave only charlie');
  assert(lastURL().searchParams.get('channel'), 'channel param missing: ' + lastURL().search);

  // chip removal: drop the In chip, then both From chips
  await page.evaluate(() => document.querySelector('#search-chips .search-chip[data-filter="in"] .chip-x').click());
  await waitRows(page, (r) => r.length === 4, 'removing the in chip did not widen back to 4');
  await page.evaluate(() => document.querySelectorAll('#search-chips .search-chip[data-filter="from"] .chip-x').forEach((x) => x.click()));
  await waitRows(page, (r) => r.length === 5, 'removing the from chips did not widen back to 5');
  assert(await page.evaluate(() => document.querySelector('#search-chips').classList.contains('hidden')), 'chip bar should hide with no filters');

  // inline tokens lift into chips once completed with a space
  await retype(page, 'from:carol deploy plan ');
  await waitRows(page, (r) => r.length === 1 && r[0].includes('delta'), 'inline from:carol did not filter to delta');
  assert((await chips(page)).join() === 'from=carol', 'inline token chip: ' + (await chips(page)).join());
  assert((await page.$eval('#search-input', (i) => i.value)) === 'deploy plan ', 'token should leave the query box');
  await page.evaluate(() => document.querySelector('#search-clear-filters').click());
  await waitRows(page, (r) => r.length === 5, 'Clear did not reset the filters');
  // two adjacent tokens lift in one pass
  await retype(page, 'from:alice in:ops deploy ');
  await waitRows(page, (r) => r.length === 1 && r[0].includes('charlie'), 'adjacent inline tokens did not both apply');
  assert((await chips(page)).join() === 'from=alice,in=#ops', 'adjacent token chips: ' + (await chips(page)).join());
  await page.evaluate(() => document.querySelector('#search-clear-filters').click());
  await waitRows(page, (r) => r.length === 5, 'Clear after adjacent tokens');

  // Kind: threads narrows to the reply and its root
  await page.click('#search-filters .sf-btn[data-sf="kind"]');
  await page.waitForSelector('#sf-pop[data-for="kind"] .sf-opt', { timeout: 3000 });
  await tick('threads');
  await waitRows(page, (r) => r.length === 2 && r.every((s) => /bravo|echo/.test(s)), 'kind:threads should show the root and the reply');
  assert(lastURL().searchParams.get('kind') === 'thread', 'kind param: ' + lastURL().search);
  await page.evaluate(() => document.querySelector('#search-chips .search-chip[data-filter="kind"] .chip-x').click());
  await waitRows(page, (r) => r.length === 5, 'removing kind chip did not widen');

  // Date preset: "Last 7 days" sends since= and keeps every (fresh) row;
  // a before date in the past hides them all
  await page.click('#search-filters .sf-btn[data-sf="date"]');
  await page.waitForSelector('#sf-pop[data-for="date"] .sf-presets', { timeout: 3000 });
  await page.click('#sf-pop [data-preset="7"]');
  await page.waitForFunction(() => document.querySelector('#search-chips .search-chip[data-filter="after"]'), { timeout: 3000 });
  await waitRows(page, (r) => r.length === 5, 'last 7 days should keep all rows');
  const since = lastURL().searchParams.get('since');
  assert(since && Date.now() - Date.parse(since) > 6 * 864e5 && Date.now() - Date.parse(since) < 8 * 864e5, 'since should sit ~7 days back: ' + since);
  await page.evaluate(() => document.querySelector('#search-chips .search-chip[data-filter="after"] .chip-x').click());
  await retype(page, 'before:2020-01-01 deploy plan ');
  await page.waitForFunction(() => document.querySelector('#search-chips .search-chip[data-filter="before"]'), { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector('#search-results .search-empty'), { timeout: 8000 }).catch(() => { throw new Error('before:2020 should empty the list'); });
  assert(lastURL().searchParams.get('until'), 'until param missing');
  await page.evaluate(() => document.querySelector('#search-clear-filters').click());

  // Has attachment: toggle sends has_attachment=true; nothing here has one
  await page.click('#search-filters .sf-btn[data-sf="has"]');
  await page.waitForFunction(() => document.querySelector('#search-chips .search-chip[data-filter="has"]'), { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector('#search-results .search-empty'), { timeout: 8000 }).catch(() => { throw new Error('has:attachment should empty the list'); });
  assert(lastURL().searchParams.get('has_attachment') === 'true', 'has_attachment param: ' + lastURL().search);
  const pressed = await page.$eval('#search-filters .sf-btn[data-sf="has"]', (b) => b.getAttribute('aria-pressed'));
  assert(pressed === 'true', 'Has attachment button should read pressed');
  await page.click('#search-filters .sf-btn[data-sf="has"]');
  await waitRows(page, (r) => r.length === 5, 'untoggling has attachment did not widen');

  // screenshot with a from + in combination for the done line
  await page.click('#search-filters .sf-btn[data-sf="from"]');
  await page.waitForSelector('#sf-pop[data-for="from"] .sf-opt', { timeout: 3000 });
  await tick('alice');
  await waitRows(page, (r) => r.length === 3, 'from alice for the screenshot');
  if (process.env.OUT) { fs.mkdirSync(process.env.OUT, { recursive: true }); await page.screenshot({ path: process.env.OUT + '/search-filters.png' }); }

  await browser.close();
  if (!process.exitCode) console.log('SEARCHFILTERS_CHECK_OK');
})().catch((e) => { console.error('SEARCHFILTERS_CHECK_FAIL:', e.message); process.exit(1); });
