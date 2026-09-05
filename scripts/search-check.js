// E2E for the unified search panel (FR-I). One query renders TWO sections in
// one panel: "Direct matches" (instant, fuzzy so typos still hit) on top and
// "Related matches" (semantic; lazy-loads under a loading row) beneath. A long
// group previews ~5 rows with a "... (see more)" inline expand. A message shown
// in Direct does not repeat in Related. On a server with no embeddings provider
// the Related section greys out with an "off" note; Direct still works.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/search-check.js
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
const launch = () => puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
async function seedLogin(page, slug, joined) {
  await openAsHuman(page, SERVER, slug, joined);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 6000 });
}
// collect the .search-hit-row snippets that sit under a given section label
const rowsUnder = (page, label) => page.evaluate((lab) => {
  const heads = [...document.querySelectorAll('#search-results .search-section')];
  const head = heads.find((h) => h.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
  if (!head) return null;
  const out = [];
  for (let n = head.nextElementSibling; n && !n.classList.contains('search-section'); n = n.nextElementSibling) {
    if (n.classList.contains('search-hit-row')) out.push(n.querySelector('.sh-snippet').textContent);
  }
  return out;
}, label);

(async () => {
  const created = await newRoom(SERVER, 'search check');
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'searchbot', description: 't', avatar: '🤖' } });
  const human = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'searchhuman', is_human: true } });
  const budget = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'the quarterly budget forecast is due next week' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'please fix the webhook config before deploy' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'lunch options near the office' } });
  // 7 hits for one keyword, to exercise the 5-row preview + see-more expand
  for (let i = 1; i <= 7; i++) {
    await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'sprint retro notes part ' + i } });
  }

  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });
  await seedLogin(page, slug, human);

  // A) open search, exact text query renders under "Direct matches"
  await page.evaluate(() => document.getElementById('open-search').click());
  await page.waitForSelector('#search-modal:not(.hidden)', { timeout: 3000 });
  await page.type('#search-input', 'budget');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#search-results .search-hit-row')];
    return rows.some((r) => r.textContent.toLowerCase().includes('budget'));
  }, { timeout: 5000 });
  const textRows = await rowsUnder(page, 'direct matches');
  if (!textRows || !textRows.some((s) => s.toLowerCase().includes('budget'))) throw new Error('budget not under Direct matches: ' + JSON.stringify(textRows));

  // click-through still flashes the target message
  await page.click('#search-results .search-hit-row');
  await page.waitForSelector('#search-modal.hidden', { timeout: 3000 });
  await page.waitForFunction((id) => {
    const n = [...document.querySelectorAll('#messages .msg')].find((x) => x.dataset.id === id);
    return n && n.classList.contains('msg-flash');
  }, { timeout: 3000 }, budget.id);

  // A2) FUZZY: a typo of "webhook" still hits under Direct matches
  await page.evaluate(() => document.getElementById('open-search').click());
  await page.waitForSelector('#search-modal:not(.hidden)', { timeout: 3000 });
  await page.click('#search-input', { clickCount: 3 });
  await page.type('#search-input', 'webook');
  // wait specifically for webhook UNDER the Text section (semantic may also surface
  // it; the point here is that fuzzy TEXT matching works), not just anywhere
  await page.waitForFunction(() => {
    const heads = [...document.querySelectorAll('#search-results .search-section')];
    const head = heads.find((h) => h.textContent.trim().toLowerCase().startsWith('direct'));
    if (!head) return false;
    for (let n = head.nextElementSibling; n && !n.classList.contains('search-section'); n = n.nextElementSibling) {
      if (n.classList.contains('search-hit-row') && n.textContent.toLowerCase().includes('webhook')) return true;
    }
    return false;
  }, { timeout: 6000 });

  // B) SEMANTIC: pre-warm the embedding, then a meaning query fills the Semantic
  // section (which starts as a loading row). Also assert DEDUP: the budget hit,
  // which is a text match too, appears once total.
  let embedded = false;
  for (let i = 0; i < 25; i++) {
    const s = await api('/api/v1/search/semantic?q=' + encodeURIComponent('company financial planning'), { token: bot.token });
    if ((s.results || []).some((r) => r.id === budget.id)) { embedded = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!embedded) throw new Error('message never embedded; semantic path cannot be verified');

  await page.click('#search-input', { clickCount: 3 });
  await page.type('#search-input', 'budget');
  // both sections present; budget appears exactly once across all hit rows (dedup)
  await page.waitForFunction((id) => {
    const rows = [...document.querySelectorAll('#search-results .search-hit-row')];
    return rows.some((r) => r.textContent.toLowerCase().includes('budget'));
  }, { timeout: 8000 }, budget.id);
  // give the semantic round-trip time to land, then check dedup
  await new Promise((r) => setTimeout(r, 2500));
  const budgetCount = await page.evaluate(() =>
    [...document.querySelectorAll('#search-results .search-hit-row .sh-snippet')]
      .filter((s) => s.textContent.toLowerCase().includes('budget')).length);
  if (budgetCount !== 1) throw new Error('dedup failed: budget row count = ' + budgetCount);
  // the Related section header exists (loaded, not greyed)
  const semHead = await page.evaluate(() => {
    const h = [...document.querySelectorAll('#search-results .search-section')].find((x) => x.textContent.toLowerCase().startsWith('related'));
    return h ? { off: h.classList.contains('sec-off') } : null;
  });
  if (!semHead) throw new Error('no Related matches section rendered');
  if (semHead.off) throw new Error('Related section greyed while embeddings are enabled');

  // B2) SEE-MORE: 7 direct hits preview as 5 rows + "... (see more)"; the click
  // expands the group inline to all 7 without a new query.
  await page.click('#search-input', { clickCount: 3 });
  await page.type('#search-input', 'sprint retro notes');
  // wait for the FINAL paint (typing debounces per keystroke): 5 preview rows
  // under Direct plus a see-more row
  await page.waitForFunction(() => {
    const heads = [...document.querySelectorAll('#search-results .search-section')];
    const head = heads.find((h) => h.textContent.trim().toLowerCase().startsWith('direct'));
    if (!head) return false;
    let count = 0;
    let more = false;
    for (let n = head.nextElementSibling; n && !n.classList.contains('search-section'); n = n.nextElementSibling) {
      if (n.classList.contains('search-hit-row') && n.textContent.toLowerCase().includes('sprint')) count++;
      if (n.classList.contains('search-more')) more = true;
    }
    return count === 5 && more;
  }, { timeout: 8000 }).catch(() => { throw new Error('7-hit group never previewed as 5 rows + see-more'); });
  await page.evaluate(() => document.querySelector('#search-results .search-more').click());
  await page.waitForFunction(() => {
    const heads = [...document.querySelectorAll('#search-results .search-section')];
    const head = heads.find((h) => h.textContent.trim().toLowerCase().startsWith('direct'));
    let count = 0;
    for (let n = head.nextElementSibling; n && !n.classList.contains('search-section'); n = n.nextElementSibling) {
      if (n.classList.contains('search-hit-row')) count++;
    }
    return count === 7;
  }, { timeout: 4000 }).catch(() => { throw new Error('see-more did not expand to 7 rows'); });
  await browser.close();

  // C) DEGRADE: semantic endpoint answers 503 -> Related section greys with an
  // "off" note; Direct section still returns results.
  const b2 = await launch();
  const p2 = await b2.newPage();
  await p2.setRequestInterception(true);
  p2.on('request', (req) => {
    if (req.url().includes('/api/v1/search/semantic')) {
      req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'semantic search is disabled (no embeddings provider configured)' }) });
      return;
    }
    req.continue();
  });
  await seedLogin(p2, slug, human);
  await p2.evaluate(() => document.getElementById('open-search').click());
  await p2.waitForSelector('#search-modal:not(.hidden)', { timeout: 3000 });
  await p2.type('#search-input', 'budget');
  await p2.waitForFunction(() => {
    const h = [...document.querySelectorAll('#search-results .search-section')].find((x) => x.textContent.toLowerCase().startsWith('related'));
    const off = h && h.classList.contains('sec-off');
    const note = [...document.querySelectorAll('#search-results .search-empty')].some((n) => n.textContent.toLowerCase().includes('off on this server'));
    const textHit = [...document.querySelectorAll('#search-results .search-hit-row')].some((r) => r.textContent.toLowerCase().includes('budget'));
    return off && note && textHit;
  }, { timeout: 6000 });
  await b2.close();

  if (!process.exitCode) console.log('SEARCH_CHECK_OK');
})().catch((e) => { console.error('SEARCH_CHECK_FAIL:', e.message); process.exit(1); });
