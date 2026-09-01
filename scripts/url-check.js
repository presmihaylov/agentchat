// E2E: channel + thread persist in the URL (deep links, refresh, back/forward).
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/url-check.js
const puppeteer = require('puppeteer-core');
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

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'url check' } });
  const slug = created.room.slug;
  const agent = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'urlbot', description: 't' } });
  const root = await api('/api/v1/channels/general/messages', { method: 'POST', token: agent.token, body: { body: 'thread root here' } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: agent.token, body: { body: 'first reply', thread_root_id: root.id } });
  await api('/api/v1/channels', { method: 'POST', token: agent.token, body: { name: 'deep', topic: '' } });

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const path = () => page.evaluate(() => location.pathname);
  const waitPath = async (want) => {
    await page.waitForFunction((w) => location.pathname === w, { timeout: 8000 }, want)
      .catch(async () => { throw new Error('URL is ' + await path() + ', want ' + want); });
  };
  const currentChannel = () => page.evaluate(() =>
    document.querySelector('#channel-list li.active')?.textContent.trim());

  // 1. join lands in general and the URL is normalized to /c/general
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.type('#join-code', created.invite_code);
  await page.type('#join-name', 'humantester');
  await page.click('#join-form button[type=submit]');
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 5000 });
  await waitPath('/r/' + slug + '/c/general');

  // membership: the human must join #deep before it shows in the sidebar
  const humanToken = await page.evaluate((s) =>
    JSON.parse(localStorage.getItem('agentchat:' + s)).token, slug);
  await api('/api/v1/channels/deep/join', { method: 'POST', token: humanToken });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await waitPath('/r/' + slug + '/c/general');

  // 2. clicking a channel pushes its URL
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#channel-list li')].some((li) => li.textContent.includes('deep')), { timeout: 8000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('#channel-list li')].find((li) => li.textContent.includes('deep')).click();
  });
  await waitPath('/r/' + slug + '/c/deep');

  // 3. back/forward move between channels
  await page.goBack();
  await waitPath('/r/' + slug + '/c/general');
  await page.waitForFunction(() =>
    document.querySelector('#channel-list li.active')?.textContent.includes('general'), { timeout: 8000 })
    .catch(async () => { throw new Error('back did not reselect general, active=' + await currentChannel()); });
  await page.goForward();
  await waitPath('/r/' + slug + '/c/deep');
  await page.waitForFunction(() =>
    document.querySelector('#channel-list li.active')?.textContent.includes('deep'), { timeout: 8000 })
    .catch(async () => { throw new Error('forward did not reselect deep, active=' + await currentChannel()); });
  await page.goBack();
  await waitPath('/r/' + slug + '/c/general');

  // 4. opening a thread pushes /t/<root-id>; closing pops back off via the X
  await page.waitForFunction(() => document.querySelector('button.reply-bar'), { timeout: 8000 });
  await page.click('button.reply-bar');
  await waitPath('/r/' + slug + '/c/general/t/' + root.id);
  await page.waitForFunction(() => !document.querySelector('#thread-panel').classList.contains('hidden'), { timeout: 8000 });

  // 5. refresh restores channel + open thread from the URL
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await waitPath('/r/' + slug + '/c/general/t/' + root.id);
  await page.waitForFunction(() => !document.querySelector('#thread-panel').classList.contains('hidden'), { timeout: 8000 });
  await page.waitForFunction(() =>
    document.querySelector('#thread-messages')?.textContent.includes('first reply'), { timeout: 8000 });

  // 6. back from the restored thread closes it (URL drops /t/)
  await page.goBack();
  await waitPath('/r/' + slug + '/c/general');

  // 7. pasted deep link to another channel opens that exact channel
  await page.goto(SERVER + '/r/' + slug + '/c/deep', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() =>
    document.querySelector('#channel-list li.active')?.textContent.includes('deep'), { timeout: 8000 });
  assert(await path() === '/r/' + slug + '/c/deep', 'deep-link URL rewritten to ' + await path());

  // 8. a dead thread id in the URL degrades gracefully (channel opens, no thread)
  await page.goto(SERVER + '/r/' + slug + '/c/general/t/00000000-0000-0000-0000-000000000000', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#thread-panel').classList.contains('hidden'), { timeout: 8000 });

  await browser.close();
  console.log('URL_CHECK_OK');
})().catch((e) => { console.error('URL_CHECK_FAIL:', e.message); process.exit(1); });
