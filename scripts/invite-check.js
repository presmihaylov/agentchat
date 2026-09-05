// E2E for the "invite agent" text. Behind Cloudflare Access a bare curl to
// /skill gets the login page, so the copied invite must spell out the two
// service-token headers; on a plain room it must not mention them. Run it
// against a gated server (CLOUDFLARE_TUNNEL=true + CF_ACCESS_* in its env) with
// ACCESS_ID/ACCESS_SECRET set to the same values, or against a plain server
// with neither set. We capture the copied text by stubbing navigator.clipboard.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/invite-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs, openInviteModal } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const ACCESS_ID = process.env.ACCESS_ID || '';
const ACCESS_SECRET = process.env.ACCESS_SECRET || '';

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
  const created = await newRoom(SERVER, 'invite check');
  const slug = created.room.slug;

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await enterAs(page, SERVER, slug, created.invite_code, 'invitetester');
  await openInviteModal(page);

  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t) => { window.__copied = t; } }, configurable: true,
    });
  });
  await page.evaluate(() => document.getElementById('invite-agent-copy').click());
  await page.waitForFunction(() => window.__copied !== null, { timeout: 5000 });
  const text = await page.evaluate(() => window.__copied);

  if (!text.includes('/skill with curl')) throw new Error('invite lost the skill line: ' + text);
  const m = text.match(/Invite link: (\S+)$/);
  if (!m || !m[1].startsWith(SERVER + '/join/inv-')) throw new Error('invite lost the link: ' + text);
  if (m[1] === created.invite) throw new Error('agent instructions reuse the workspace link instead of a bound one');
  if (/Invite code:|Join link:/.test(text)) throw new Error('invite still carries the old lines: ' + text);
  if (ACCESS_ID) {
    if (!text.includes(`-H "CF-Access-Client-Id: ${ACCESS_ID}"`)) throw new Error('gated invite lacks the client id header: ' + text);
    if (!text.includes(`-H "CF-Access-Client-Secret: ${ACCESS_SECRET}"`)) throw new Error('gated invite lacks the client secret header: ' + text);
    if (!text.includes('Cloudflare Access')) throw new Error('gated invite does not explain the headers: ' + text);
  }
  if (!ACCESS_ID && /CF-Access|Cloudflare/.test(text)) throw new Error('plain invite mentions Access: ' + text);

  await browser.close();
  console.log('INVITE_CHECK_OK', ACCESS_ID ? '(gated)' : '(plain)');
})().catch((e) => { console.error('INVITE_CHECK_FAIL:', e.message); process.exit(1); });
