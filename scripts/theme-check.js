require('fs').mkdirSync(process.env.OUT || 'tmp', { recursive: true });
// E2E for the theme toggle: "System" follows the OS, Dark/Light force a palette,
// the choice survives a reload, and the highlight.js sheet swaps with the theme.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/theme-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, openAsHuman, openSettings, backToRoom } = require('./lib/login.js');
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
  const created = await newRoom(SERVER, 'theme check');
  const slug = created.room.slug;
  const alice = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'alice', is_human: true } });
  await api('/api/v1/channels/general/messages', { method: 'POST', token: alice.token, body: { body: 'code:\n\n```js\nconst x = 1;\n```' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Emulation.setEmulatedMedia is flaky across Chrome builds, so stub matchMedia
  // for the light-scheme query before the head script runs; os() flips it live.
  await page.evaluateOnNewDocument(() => {
    const listeners = new Set();
    window.__osLight = false;
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      if (q !== '(prefers-color-scheme: light)') return real(q);
      return {
        get matches() { return window.__osLight; },
        addEventListener: (_, fn) => listeners.add(fn),
        removeEventListener: (_, fn) => listeners.delete(fn),
      };
    };
    window.__setOs = (light) => { window.__osLight = light; listeners.forEach((fn) => fn()); };
  });
  const os = (scheme) => page.evaluate((light) => window.__setOs(light), scheme === 'light');
    await openAsHuman(page, SERVER, slug, alice);
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  const state = () => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.themeMode,
    bg: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
    hljsDark: !document.getElementById('hljs-dark').disabled,
    hljsLight: !document.getElementById('hljs-light').disabled,
    scheme: getComputedStyle(document.documentElement).colorScheme,
  }));
  const lum = (rgb) => rgb.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;

  // 1. default is "system": a dark OS gives the dark palette
  let s = await state();
  assert(s.mode === 'system' && s.theme === 'dark', 'default: ' + JSON.stringify(s));
  assert(lum(s.bg) < 60 && lum(s.text) > 180, 'dark palette: ' + JSON.stringify(s));
  assert(s.hljsDark && !s.hljsLight && s.scheme === 'dark', 'dark sheets: ' + JSON.stringify(s));

  // 2. still "system": flipping the OS to light flips the page, no reload
  await os('light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 5000 });
  s = await state();
  assert(lum(s.bg) > 200 && lum(s.text) < 80, 'light palette: ' + JSON.stringify(s));
  assert(!s.hljsDark && s.hljsLight && s.scheme === 'light', 'light sheets: ' + JSON.stringify(s));

  // 3. the settings select forces Dark even on a light OS (the settings page
  //    is a fresh document, so the stubbed OS starts dark there; the select
  //    must win regardless)
  await openSettings(page, SERVER);
  await page.waitForSelector('#theme-mode', { visible: true, timeout: 5000 });
  assert((await page.$eval('#theme-mode', (el) => el.value)) === 'system', 'select did not show the current mode');
  await page.select('#theme-mode', 'dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 5000 });
  s = await state();
  assert(s.mode === 'dark' && lum(s.bg) < 60 && s.hljsDark && !s.hljsLight, 'forced dark: ' + JSON.stringify(s));
  await backToRoom(page);

  // 4. the choice persists across a reload and ignores the OS
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });
  s = await state();
  assert(s.mode === 'dark' && s.theme === 'dark', 'dark did not persist: ' + JSON.stringify(s));
  await openSettings(page, SERVER);
  await page.waitForSelector('#theme-mode', { visible: true, timeout: 5000 });
  assert((await page.$eval('#theme-mode', (el) => el.value)) === 'dark', 'select lost the persisted mode');

  // 5. forced Light on a dark OS, and the code block picks up the light sheet
  await os('dark');
  await page.select('#theme-mode', 'light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 5000 });
  await backToRoom(page);
  await os('dark');
  s = await state();
  assert(s.mode === 'light' && lum(s.bg) > 200 && s.hljsLight && !s.hljsDark, 'forced light: ' + JSON.stringify(s));
  const codeBg = await page.$eval('#messages .msg pre code', (el) => getComputedStyle(el).backgroundColor);
  assert(lum(codeBg) > 200, 'code block still dark in light mode: ' + codeBg);
  await page.screenshot({ path: (process.env.OUT || 'tmp') + '/theme-light.png' });

  // 6. back to System: follows the (dark) OS again
  await openSettings(page, SERVER);
  await page.waitForSelector('#theme-mode', { visible: true, timeout: 5000 });
  await page.select('#theme-mode', 'system');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 5000 });
  assert((await page.evaluate(() => localStorage.getItem('agentchat:theme'))) === 'system', 'mode not stored');

  await browser.close();
  console.log('THEME_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
