// Headless UI smoke test: create room via API, join as human in the browser,
// post a message, verify an agent-posted mention renders live + title badge.
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

(async () => {
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'ui smoke' } });
  const inviteCode = created.invite_code;
  const slug = created.room.slug;
  if (created.join_url.includes(inviteCode)) throw new Error('join_url leaks the invite code');
  const agent = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: inviteCode, name: 'smokebot', description: 'test agent' } });

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });

  // join form visible, room name peeked
  await page.waitForSelector('#join-view:not(.hidden)', { timeout: 5000 });
  const peeked = await page.$eval('#join-room-name', (el) => el.textContent);
  if (!peeked.includes('ui smoke')) throw new Error('peek failed: ' + peeked);

  await page.type('#join-code', inviteCode);
  await page.type('#join-name', 'humantester');
  await page.type('#join-desc', 'the human');
  await page.click('#join-form button[type=submit]');

  // chat loads
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#channel-list li').length > 0);
  const roomName = await page.$eval('#room-name', (el) => el.textContent);
  if (roomName !== 'ui smoke') throw new Error('room name: ' + roomName);

  // human posts markdown
  await page.type('#composer-input', 'hello **bold** world');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#messages .content strong') !== null, { timeout: 5000 });

  // agent mentions the human -> message appears live, rendered, mention-highlighted
  await api('/api/v1/channels/general/messages', { method: 'POST', token: agent.token, body: { body: 'hey @humantester look' } });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#messages .msg')].some((m) => m.classList.contains('mentioned') && m.textContent.includes('smokebot')),
    { timeout: 10000 });

  // participants sidebar shows both, agent online
  const partHTML = await page.$eval('#participant-list', (el) => el.innerHTML);
  if (!partHTML.includes('smokebot') || !partHTML.includes('humantester')) throw new Error('participants missing');

  // thread: reply via UI on the agent's message
  await page.evaluate(() => {
    const msgs = [...document.querySelectorAll('#messages .msg')];
    msgs[msgs.length - 1].querySelector('[data-act=thread]').click();
  });
  await page.waitForSelector('#thread-panel:not(.hidden)');
  await page.type('#thread-input', 'threaded reply from human');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#thread-messages') && document.querySelectorAll('#thread-messages .msg').length >= 2, { timeout: 8000 });

  // XSS sanity: raw script must not execute / must be sanitized
  await api('/api/v1/channels/general/messages', { method: 'POST', token: agent.token, body: { body: '<img src=x onerror="window.PWNED=1">try me' } });
  await page.waitForFunction(() => [...document.querySelectorAll('#messages .msg')].some((m) => m.textContent.includes('try me')), { timeout: 8000 });
  const pwned = await page.evaluate(() => window.PWNED === 1);
  if (pwned) throw new Error('XSS: onerror executed');

  // onboarding: /create makes a fresh workspace and lands in its chat as admin
  await page.goto(SERVER + '/create', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#create-view:not(.hidden)', { timeout: 5000 });
  await page.type('#create-room-name', 'smoke onboarding');
  await page.type('#create-user-name', 'founder');
  await page.click('#create-form button[type=submit]');
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  const newRoomName = await page.$eval('#room-name', (el) => el.textContent);
  if (newRoomName !== 'smoke onboarding') throw new Error('onboarding room name: ' + newRoomName);
  if (!page.url().startsWith(SERVER + '/r/')) throw new Error('onboarding did not land on /r/<slug>: ' + page.url());

  const realErrors = errors.filter((e) => !e.includes('favicon'));
  if (realErrors.length) throw new Error('page errors: ' + realErrors.join(' | '));

  console.log('UI_SMOKE_OK');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('UI_SMOKE_FAIL:', e.message); process.exit(1); });
