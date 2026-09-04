// E2E for the collapsible agent list (FR-J). Each human parent in the roster
// gets a chevron that expands/collapses its nested agents. Agents are COLLAPSED
// by default; the per-human choice persists in localStorage across reloads. A
// collapsed parent still shows a hidden-agent count and rolls up a glow when a
// hidden agent is online, so no presence signal is lost.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 node scripts/roster-check.js
const puppeteer = require('puppeteer-core');
const { newRoom } = require('./lib/login.js');
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

// roster state for the Maya parent row, read from the live DOM
const state = (page) => page.evaluate(() => {
  const lis = [...document.querySelectorAll('#participant-list li')];
  const maya = lis.find((li) => {
    const n = li.querySelector('.pname');
    return n && n.textContent === 'Maya' && li.querySelector('.p-toggle');
  });
  if (!maya) return null;
  const kidVisible = lis.some((li) => li.classList.contains('participant-leaf') &&
    li.querySelector('.pname') && /^infra-/.test(li.querySelector('.pname').textContent));
  return {
    chevron: maya.querySelector('.p-toggle').textContent,
    count: (maya.querySelector('.p-agentcount') || {}).textContent || null,
    rollup: maya.classList.contains('rollup'),
    kidVisible,
  };
});
const clickToggle = (page) => page.evaluate(() => {
  const lis = [...document.querySelectorAll('#participant-list li')];
  const maya = lis.find((li) => {
    const n = li.querySelector('.pname');
    return n && n.textContent === 'Maya' && li.querySelector('.p-toggle');
  });
  maya.querySelector('.p-toggle').click();
});

(async () => {
  const created = await newRoom(SERVER, 'roster check');
  const slug = created.room.slug;
  const maya = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'Maya', avatar: '🧑', is_human: true } });
  const inv = await api('/api/v1/invites', { method: 'POST', token: maya.token });
  // two agents owned by Maya, both online
  await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: inv.invite_code, name: 'infra-bot', avatar: '🤖' } });
  await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: inv.invite_code, name: 'infra-qa', avatar: '📊' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exitCode = 1; });

  const login = async () => {
    await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
    await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, maya.token);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#participant-list li .pname', { timeout: 6000 });
  };
  await login();

  // 1) DEFAULT COLLAPSED: chevron ▸, count 2, kids hidden, rollup glow (agents online)
  let s = await state(page);
  if (!s) throw new Error('Maya parent row not found');
  if (s.chevron !== '▸') throw new Error('expected collapsed chevron, got ' + JSON.stringify(s));
  if (s.count !== '2') throw new Error('expected hidden-agent count 2, got ' + JSON.stringify(s));
  if (s.kidVisible) throw new Error('agents should be hidden by default');
  if (!s.rollup) throw new Error('online hidden agent should roll up a glow, got ' + JSON.stringify(s));

  // 2) TOGGLE EXPAND: chevron ▾, kids visible, no count, rollup cleared
  await clickToggle(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#participant-list li.participant-leaf .pname')].some((n) => /^infra-/.test(n.textContent)), { timeout: 3000 });
  s = await state(page);
  if (s.chevron !== '▾' || !s.kidVisible || s.count !== null || s.rollup) throw new Error('expand state wrong: ' + JSON.stringify(s));

  // 3) PERSIST EXPANDED across reload
  await login();
  s = await state(page);
  if (!s.kidVisible || s.chevron !== '▾') throw new Error('expanded choice did not persist: ' + JSON.stringify(s));

  // 4) COLLAPSE + PERSIST across reload
  await clickToggle(page);
  await page.waitForFunction(() => ![...document.querySelectorAll('#participant-list li.participant-leaf .pname')].some((n) => /^infra-/.test(n.textContent)), { timeout: 3000 });
  await login();
  s = await state(page);
  if (s.kidVisible || s.chevron !== '▸') throw new Error('collapsed choice did not persist: ' + JSON.stringify(s));

  await browser.close();
  if (!process.exitCode) console.log('ROSTER_CHECK_OK');
})().catch((e) => { console.error('ROSTER_CHECK_FAIL:', e.message); process.exit(1); });
