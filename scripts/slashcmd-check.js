// E2E for composer slash commands: "/" opens the command autocomplete, /invite
// adds a participant to the current channel (happy path), a bad target surfaces
// an inline error, and the raw "/command" text is never posted as a message.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/slashcmd-check.js
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
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'slash cmd check' } });
  const slug = created.room.slug, code = created.invite_code;
  const H = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'slasher', avatar: '🧑', is_human: true } });
  const A = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'invitee', avatar: '🤖' } });
  // H creates #dev (creator auto-joins); the agent is NOT a member yet.
  const dev = await api('/api/v1/channels', { method: 'POST', token: H.token, body: { name: 'dev', topic: 'slash target' } });
  const devID = dev.channel ? dev.channel.id : dev.id;

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, H.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#channel-list li', { timeout: 6000 });

  // switch to #dev
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#channel-list li')].find((x) => x.textContent.includes('dev'));
    li.click();
  });
  await page.waitForFunction(() => document.querySelector('#channel-title')?.textContent.includes('dev') ||
    document.title.length > 0, { timeout: 4000 });

  // typing "/" opens the command autocomplete with /invite in it
  await page.click('#composer-input');
  await page.type('#composer-input', '/');
  await page.waitForSelector('.slash-ac:not(.hidden)', { timeout: 4000 });
  const opts = await page.$eval('.slash-ac', (el) => el.textContent);
  if (!opts.includes('/invite')) fail('command popup missing /invite: ' + opts);

  // keyboard flow: type "inv", Enter picks the command and fills "/invite "
  await page.type('#composer-input', 'inv');
  await page.keyboard.press('Enter');
  const filled = await page.$eval('#composer-input', (el) => el.value);
  if (filled !== '/invite ') fail('Enter should fill "/invite ", got: ' + JSON.stringify(filled));

  // happy path: /invite @invitee -> inline confirmation, agent becomes a member
  await page.type('#composer-input', '@invitee');
  // the mention autocomplete may be open on "@invitee"; Escape it so Enter submits
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const s = document.querySelector('#composer .composer-status');
    return s && !s.classList.contains('hidden') && s.textContent.includes('Added invitee');
  }, { timeout: 4000 });
  const okErr = await page.$eval('#composer .composer-status', (el) => el.classList.contains('err'));
  if (okErr) fail('happy-path status rendered as an error');
  const agentChans = await api('/api/v1/channels', { token: A.token });
  const inDev = (agentChans.channels || agentChans || []).some?.((c) => c.id === devID)
    || JSON.stringify(agentChans).includes(devID);
  if (!inDev) fail('invitee is not a member of #dev after /invite');

  // error path: inviting an unknown participant surfaces an inline error
  await page.type('#composer-input', '/invite @nobody-here');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const s = document.querySelector('#composer .composer-status');
    return s && !s.classList.contains('hidden') && s.classList.contains('err');
  }, { timeout: 4000 });
  // the failed command text stays in the composer for correction
  const kept = await page.$eval('#composer-input', (el) => el.value);
  if (!kept.includes('/invite')) fail('failed command text was cleared');

  // the raw slash text must never land as a channel message
  const msgs = await api('/api/v1/channels/dev/messages?limit=20', { token: H.token });
  if ((msgs.messages || []).some((m) => m.body.startsWith('/invite'))) fail('raw /invite text was posted as a message');

  await browser.close();
  if (!process.exitCode) console.log('SLASHCMD_CHECK_OK');
})().catch((e) => { console.error('SLASHCMD_CHECK_FAIL:', e.message); process.exit(1); });
