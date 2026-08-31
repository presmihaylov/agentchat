// E2E for mention highlighting (FR-H). A message that mentions you must NOT get
// a full-width background tint; only the inline mention token is styled — a
// stronger accent pill when it targets YOU (your name or @channel/@here/
// @everyone), a plainer chip for someone else. Run:
//   NODE_PATH=<dir with puppeteer-core> node scripts/mention-check.js
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
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'mention check' } });
  const code = created.invite_code, slug = created.room.slug;
  const maya = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'Maya', avatar: '🧑', is_human: true } });
  const dev = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: code, name: 'plain-dev', avatar: '🛠️' } });
  // direct mention of Maya + a mention of someone else
  const direct = await api('/api/v1/channels/general/messages', { method: 'POST', token: dev.token, body: { body: 'hey @Maya can you review, cc @plain-dev' } });
  // a broadcast (targets everyone, so it targets Maya too)
  const bcast = await api('/api/v1/channels/general/messages', { method: 'POST', token: dev.token, body: { body: 'heads up @channel deploy in 5' } });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
  page.on('pageerror', (e) => fail('pageerror ' + e.message));

  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, maya.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector(`.msg[data-id="${direct.id}"]`, { timeout: 6000 });

  // the feed background — a mentioning message must match it, not carry a tint
  const feedBg = await page.$eval('#messages', (el) => getComputedStyle(el).backgroundColor);
  const msgBg = (id) => page.$eval(`.msg[data-id="${id}"]`, (el) => getComputedStyle(el).backgroundColor);
  const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  for (const [id, label] of [[direct.id, 'direct-mention'], [bcast.id, 'broadcast']]) {
    const bg = await msgBg(id);
    if (!(transparent(bg) || bg === feedBg)) fail(`${label} message still has a full-width tint: ${bg} (feed ${feedBg})`);
  }

  // token classes: @Maya and @channel are "me", @plain-dev is a plain chip
  const cls = (id, text) => page.evaluate((mid, t) => {
    const el = [...document.querySelectorAll(`.msg[data-id="${mid}"] .content .mention`)].find((n) => n.textContent === t);
    return el ? el.className : null;
  }, id, text);

  const preCls = await cls(direct.id, '@Maya');
  if (!preCls || !/\bmention-me\b/.test(preCls)) fail(`@Maya should be mention-me, got "${preCls}"`);
  const devCls = await cls(direct.id, '@plain-dev');
  if (!devCls || /\bmention-me\b/.test(devCls)) fail(`@plain-dev should be a plain mention chip, got "${devCls}"`);
  const chCls = await cls(bcast.id, '@channel');
  if (!chCls || !/\bmention-me\b/.test(chCls)) fail(`@channel should be mention-me, got "${chCls}"`);

  // the me-pill actually paints (accent fill), distinct from a plain chip
  const meBg = await page.evaluate((mid) => {
    const el = [...document.querySelectorAll(`.msg[data-id="${mid}"] .mention-me`)][0];
    return el ? getComputedStyle(el).backgroundColor : null;
  }, direct.id);
  if (transparent(meBg)) fail(`mention-me pill has no background: ${meBg}`);

  await browser.close();
  if (!process.exitCode) console.log('MENTION_CHECK_OK');
})().catch((e) => { console.error(e); process.exit(1); });
