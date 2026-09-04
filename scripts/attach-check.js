// E2E for attachments in BOTH composers. The thread reply composer shipped
// without any attach path at all (no 📎, no paste handler, and post() dropped
// the pending file whenever it had a thread root), so this check drives the
// real file input in each composer and asserts the sent message carries it.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/attach-check.js
const puppeteer = require('puppeteer-core');
const { newRoom } = require('./lib/login.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = process.env.SERVER || 'http://localhost:8095';

async function api(p, opts = {}) {
  const resp = await fetch(SERVER + p, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status >= 400) throw new Error(p + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const created = await newRoom(SERVER, 'attach check');
  const slug = created.room.slug;
  const me = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'viewer', is_human: true } });
  const gen = (await api('/api/v1/channels', { token: me.token })).channels.find((c) => c.name === 'general');
  const root = await api('/api/v1/channels/' + gen.id + '/messages', {
    method: 'POST', token: me.token, body: { body: 'thread root' },
  });

  // a 1x1 PNG and a plain text file: "any attachments actually", not images only
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-check-'));
  const png = path.join(dir, 'dot.png');
  fs.writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, 'hello from a thread reply\n');

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); });
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.evaluate((s, t) => localStorage.setItem('agentchat:' + s, JSON.stringify({ token: t })), slug, me.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  // ---- 1. main composer still attaches (regression guard on the refactor)
  const mainInput = await page.$('#attach-input');
  assert(mainInput, 'no #attach-input in the main composer');
  await mainInput.uploadFile(png);
  await page.waitForFunction(() => !document.getElementById('attach-pending').classList.contains('hidden'), { timeout: 5000 });
  await page.type('#composer-input', 'main with a file');
  await page.evaluate(() => document.getElementById('composer').requestSubmit());
  await sleep(1200);

  // ---- 2. the thread composer has its own attach control
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#messages .msg')].pop();
    el.querySelector('.reply-btn, [data-act="reply"], button').click();
  }).catch(() => {});
  // fall back to the URL route into the thread if the button shape differs
  await page.goto(SERVER + '/r/' + slug + '/c/general/t/' + root.id, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#thread-panel:not(.hidden)', { timeout: 8000 });

  const thAttach = await page.$('#thread-attach-input');
  assert(thAttach, 'ATTACH_CHECK_FAIL: the thread composer has no file input (#thread-attach-input)');
  const thLabel = await page.$('#thread-attach-label');
  assert(thLabel, 'ATTACH_CHECK_FAIL: the thread composer has no visible 📎 attach button');

  await thAttach.uploadFile(txt);
  await page.waitForFunction(
    () => !document.getElementById('thread-attach-pending').classList.contains('hidden'),
    { timeout: 5000 },
  );
  // the two slots are independent: filling the thread one must not touch main
  const mainStillClear = await page.evaluate(() => document.getElementById('attach-pending').classList.contains('hidden'));
  assert(mainStillClear, 'ATTACH_CHECK_FAIL: a thread upload leaked into the main composer chip');

  await page.type('#thread-input', 'reply with a file');
  await page.evaluate(() => document.getElementById('thread-composer').requestSubmit());
  await sleep(1500);

  // ---- 3. the server actually stored both, on the right messages
  const msgs = (await api('/api/v1/channels/' + gen.id + '/messages?limit=50', { token: me.token })).messages;
  const main = msgs.find((m) => m.body === 'main with a file');
  assert(main && (main.attachments || []).length === 1, 'ATTACH_CHECK_FAIL: main-composer attachment lost: ' + JSON.stringify(main));

  const thread = (await api('/api/v1/threads/' + root.id, { token: me.token })).messages
    .find((m) => m.body === 'reply with a file');
  assert(thread, 'ATTACH_CHECK_FAIL: the thread reply never posted');
  assert((thread.attachments || []).length === 1,
    'ATTACH_CHECK_FAIL: the thread reply carries no attachment: ' + JSON.stringify(thread.attachments));
  assert(thread.attachments[0].filename === 'notes.txt',
    'ATTACH_CHECK_FAIL: wrong file on the reply: ' + JSON.stringify(thread.attachments[0]));

  // ---- 4. the chip clears after the send, so the next reply does not re-send it
  const cleared = await page.evaluate(() => document.getElementById('thread-attach-pending').classList.contains('hidden'));
  assert(cleared, 'ATTACH_CHECK_FAIL: the thread attach chip survived the send');

  // ---- 5. a file staged in one thread must not follow you into the next one
  const root2 = await api('/api/v1/channels/' + gen.id + '/messages', {
    method: 'POST', token: me.token, body: { body: 'second root' },
  });
  await (await page.$('#thread-attach-input')).uploadFile(txt);
  await page.waitForFunction(
    () => !document.getElementById('thread-attach-pending').classList.contains('hidden'),
    { timeout: 5000 },
  );
  // switch threads IN-APP: a page reload would clear the slot on its own and
  // prove nothing about the switch itself
  await page.waitForFunction(
    (id) => [...document.querySelectorAll('#messages [data-id]')].some((n) => n.dataset.id === id),
    { timeout: 8000 }, root2.id);
  await page.evaluate((id) => {
    const el = [...document.querySelectorAll('#messages [data-id]')].find((n) => n.dataset.id === id);
    el.querySelector('[data-act="thread"]').click();
  }, root2.id);
  await sleep(1200);
  const carried = await page.evaluate(() => !document.getElementById('thread-attach-pending').classList.contains('hidden'));
  assert(!carried, 'ATTACH_CHECK_FAIL: a staged file followed the switch to another thread');

  await browser.close();
  console.log('ATTACH_CHECK_OK');
})().catch((e) => { console.error('ATTACH_CHECK_FAIL', e.message); process.exit(1); });
