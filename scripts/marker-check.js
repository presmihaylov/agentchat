// E2E for "working on it" markers (FR-F). A viewer watches a channel; agents
// set/update/clear markers via the API and the marker row under the message
// must appear, update, and disappear LIVE through the event stream. Also covers
// multi-agent markers and auto-clear when the marking agent replies in-thread.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/marker-check.js
const puppeteer = require('puppeteer-core');
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

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'marker check' } });
  const code = created.invite_code, slug = created.room.slug;
  const viewer = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'viewer', avatar: '🧑', is_human: true } });
  const dev = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'plain-dev', avatar: '🛠️' } });
  const qa = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'qa-bot', avatar: '🔎' } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: viewer.token, body: { body: 'Please ship the login fix.' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, viewer.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector(`.msg[data-id="${root.id}"]`, { timeout: 6000 });

  const markerTexts = () => page.$$eval(`.msg[data-id="${root.id}"] .msg-marker .mk-text`,
    (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const waitMarkers = async (n, label) => {
    try { await page.waitForFunction((id, want) =>
      document.querySelectorAll(`.msg[data-id="${id}"] .msg-marker`).length === want, { timeout: 4000 }, root.id, n);
    } catch (e) { fail(`${label}: expected ${n} markers, got ${(await markerTexts()).length}`); }
  };

  // dev marks the message -> one marker appears live with the status label
  await api(`/api/v1/messages/${root.id}/working`, { method: 'POST', token: dev.token, body: { status: 'scoping' } });
  await waitMarkers(1, 'after dev set');
  let txt = (await markerTexts())[0] || '';
  if (!/plain-dev/.test(txt) || !/working on this/.test(txt) || !/scoping/.test(txt)) fail(`marker text wrong: "${txt}"`);

  // dev updates the status in place -> still one marker, new label, live
  await api(`/api/v1/messages/${root.id}/working`, { method: 'POST', token: dev.token, body: { status: 'PR opening' } });
  try { await page.waitForFunction((id) =>
    /PR opening/.test(document.querySelector(`.msg[data-id="${id}"] .msg-marker .mk-text`)?.textContent || ''),
    { timeout: 4000 }, root.id); } catch (e) { fail('status did not update live'); }
  await waitMarkers(1, 'after dev update');

  // a second agent marks the same message -> two independent markers
  await api(`/api/v1/messages/${root.id}/working`, { method: 'POST', token: qa.token, body: { status: '' } });
  await waitMarkers(2, 'after qa set (multi-agent)');

  // dev replies into the thread -> dev's marker auto-clears, qa's remains
  await api('/api/v1/channels/general/messages', { method: 'POST', token: dev.token, body: { body: 'PR is up', thread_root_id: root.id } });
  await waitMarkers(1, 'after dev replies (auto-clear)');
  txt = (await markerTexts())[0] || '';
  if (!/qa-bot/.test(txt)) fail(`after auto-clear the remaining marker should be qa-bot, got "${txt}"`);

  // qa clears by hand -> no markers left
  await api(`/api/v1/messages/${root.id}/working`, { method: 'DELETE', token: qa.token });
  await waitMarkers(0, 'after qa clears');

  await browser.close();
  if (!process.exitCode) console.log('MARKER_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
