// E2E for the non-secure-context clipboard fallback. On plain-HTTP LAN prod
// navigator.clipboard is undefined, so copy must fall back to a hidden textarea
// + document.execCommand('copy') and confirm success only when it actually
// worked, else show an error state. We null out navigator.clipboard to force
// the fallback and stub execCommand so the assertion does not depend on the
// headless browser's real clipboard, which is unreliable.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/copy-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs, openInviteModal } = require('./lib/login.js');
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

(async () => {
  const created = await newRoom(SERVER, 'copy check');
  const slug = created.room.slug;

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await enterAs(page, SERVER, slug, created.invite_code, 'copytester');
  await openInviteModal(page);
  await page.waitForSelector('#invite-list .invite-copy', { timeout: 8000 });

  // instrument: hide the clipboard API (as plain HTTP does) and stub execCommand
  // so we can drive both the success and failure branches deterministically
  const install = (execResult) => page.evaluate((res) => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    window.__execCalls = [];
    window.__sawTextarea = false;
    document.execCommand = (cmd) => {
      window.__execCalls.push(cmd);
      // the fallback must have a textarea selected at copy time
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') window.__sawTextarea = true;
      return res;
    };
  }, execResult);

  const clickCopy = () => page.evaluate(() => document.querySelector('#invite-list .invite-copy').click());
  // the composer is itself a textarea, so count the baseline and assert the
  // fallback adds none net (it must remove its scratch textarea after copying)
  const baselineTextareas = await page.evaluate(() => document.querySelectorAll('textarea').length);

  // success path: execCommand returns true -> button confirms, textarea was used
  await install(true);
  await clickCopy();
  // the button is an icon since the invite modal redesign: check = copied, triangle = failed, copy = idle
  const iconIs = (name) => `document.querySelector('#invite-list .invite-copy svg').dataset.icon === '${name}'`;
  await page.waitForFunction(iconIs('check'), { timeout: 5000 });
  const okState = await page.evaluate(() => ({
    calls: window.__execCalls, sawTextarea: window.__sawTextarea,
    textareas: document.querySelectorAll('textarea').length,
  }));
  if (!okState.calls.includes('copy')) throw new Error('fallback did not call execCommand copy: ' + JSON.stringify(okState));
  if (!okState.sawTextarea) throw new Error('fallback did not select a textarea: ' + JSON.stringify(okState));
  if (okState.textareas !== baselineTextareas) throw new Error('fallback left a scratch textarea in the DOM: ' + JSON.stringify(okState));

  // let the label restore, then drive the failure path
  await page.waitForFunction(iconIs('copy'), { timeout: 5000 });
  await install(false);
  await clickCopy();
  await page.waitForFunction(iconIs('triangle-alert'), { timeout: 5000 });

  await browser.close();
  console.log('COPY_CHECK_OK');
})().catch((e) => { console.error('COPY_CHECK_FAIL:', e.message); process.exit(1); });
