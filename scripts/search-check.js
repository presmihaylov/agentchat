// E2E for the search bar: ⌘K/Ctrl-K opens it, text search renders immediately
// with channel/author/snippet, a result click jumps to and flashes the message,
// semantic mode lazy-loads, and the semantic toggle degrades gracefully (greyed
// with a hint) when the endpoint answers 503.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/search-check.js
const puppeteer = require('puppeteer-core');
const SERVER = 'http://localhost:8090';

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

const launch = () => puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function join(page, slug, code, name) {
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.type('#join-code', code);
  await page.type('#join-name', name);
  await page.click('#join-form button[type=submit]');
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 5000 });
}

async function ctrlK(page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await page.waitForSelector('#search-modal:not(.hidden)', { timeout: 3000 });
}

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'search check' } });
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'searchbot', description: 't', avatar: '🤖' } });
  const budget = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'the quarterly budget forecast is due next week' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'lunch options near the office' } });

  // ---- Part A + B: real server (dev has semantic enabled) ----
  const browser = await launch();
  const page = await browser.newPage();
  await join(page, slug, created.invite_code, 'searchhuman');

  // A) open via the header search field, text search renders with channel/author/snippet
  await page.evaluate(() => document.getElementById('open-search').click());
  await page.waitForSelector('#search-modal:not(.hidden)', { timeout: 3000 });
  await page.type('#search-input', 'budget');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#search-results .search-hit-row')]
      .some((r) => r.textContent.toLowerCase().includes('budget')), { timeout: 5000 });
  const meta = await page.evaluate(() => {
    const row = document.querySelector('#search-results .search-hit-row');
    return {
      channel: row.querySelector('.sh-channel').textContent,
      author: row.querySelector('.sh-author').textContent,
      snippet: row.querySelector('.sh-snippet').textContent,
    };
  });
  if (!meta.channel.includes('general')) throw new Error('result missing channel: ' + JSON.stringify(meta));
  if (meta.author !== 'searchbot') throw new Error('result missing author: ' + JSON.stringify(meta));
  if (!meta.snippet.toLowerCase().includes('budget')) throw new Error('result missing snippet: ' + JSON.stringify(meta));

  // click-through: modal closes and the target message flashes in the channel
  await page.click('#search-results .search-hit-row');
  await page.waitForSelector('#search-modal.hidden', { timeout: 3000 });
  await page.waitForFunction((id) => {
    const n = [...document.querySelectorAll('#messages .msg')].find((x) => x.dataset.id === id);
    return n && n.classList.contains('search-flash');
  }, { timeout: 3000 }, budget.id);

  // B) semantic enabled: toggle is usable and the hint stays hidden
  await ctrlK(page);
  await page.waitForFunction(() => !document.getElementById('mode-semantic').classList.contains('disabled'), { timeout: 5000 });
  if (!await page.evaluate(() => document.getElementById('search-hint').classList.contains('hidden')))
    throw new Error('hint should be hidden when semantic is enabled');

  // pre-warm the async embedding so the semantic hit is deterministic
  let embedded = false;
  for (let i = 0; i < 20; i++) {
    const s = await api('/api/v1/search/semantic?q=' + encodeURIComponent('company financial planning'), { token: bot.token });
    if ((s.results || []).some((r) => r.id === budget.id)) { embedded = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!embedded) throw new Error('message never embedded; semantic search cannot be verified');

  // switch to semantic mode, retype: a loading row shows, then the hit resolves
  await page.click('#mode-semantic');
  await page.click('#search-input', { clickCount: 3 });
  await page.type('#search-input', 'company financial planning');
  await page.waitForFunction((id) =>
    [...document.querySelectorAll('#search-results .search-hit-row .sh-snippet')]
      .some((s) => s.textContent.toLowerCase().includes('budget')), { timeout: 8000 }, budget.id);
  await browser.close();

  // ---- Part C: graceful degrade when the semantic endpoint answers 503 ----
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
  await join(p2, slug, created.invite_code, 'nosemhuman');
  await ctrlK(p2);
  await p2.waitForFunction(() => {
    const b = document.getElementById('mode-semantic');
    const hint = document.getElementById('search-hint');
    return b.classList.contains('disabled') && !hint.classList.contains('hidden') && hint.textContent.length > 0;
  }, { timeout: 5000 });
  await b2.close();

  console.log('SEARCH_CHECK_OK');
})().catch((e) => { console.error('SEARCH_CHECK_FAIL:', e.message); process.exit(1); });
