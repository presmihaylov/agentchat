// E2E: a .md attachment opens in place as rendered markdown (headings, table,
// code) instead of only downloading; a .txt opens verbatim; Escape closes.
// Maya: "I want rendering to support full markdown in entries".
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/docpreview-check.js
const puppeteer = require('puppeteer-core');
const { newRoom } = require('./lib/login.js');
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

async function upload(token, name, text) {
  const fd = new FormData();
  fd.append('file', new Blob([text]), name);
  const resp = await fetch(SERVER + '/api/v1/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const data = await resp.json();
  if (!resp.ok) throw new Error('upload ' + name + ' -> ' + resp.status + ' ' + JSON.stringify(data));
  return data;
}

const MD = '# Compat report\n\n**Short answer: yes.**\n\n| Framework | Ok |\n| --- | --- |\n| eve | yes |\n| mastra | yes |\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n';
const TXT = 'line one\n# not a heading\n<b>not bold</b>\n';

(async () => {
  const created = await newRoom(SERVER, 'docpreview check');
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'docbot', description: 't', avatar: '🤖' } });
  const md = await upload(bot.token, 'report.md', MD);
  const txt = await upload(bot.token, 'notes.txt', TXT);
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'files attached', attachment_ids: [md.id, txt.id] } });

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(SERVER + '/r/' + created.room.slug, { waitUntil: 'networkidle2' });
  await page.type('#join-code', created.invite_code);
  await page.type('#join-name', 'reader');
  await page.click('#join-form button[type=submit]');
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('button.attachment[data-name="report.md"]', { timeout: 8000 });

  const shown = () => page.evaluate(() => !document.getElementById('doc-modal').classList.contains('hidden'));

  // 1. the .md opens rendered: heading, bold, table rows, list, highlighted code
  await page.click('button.attachment[data-name="report.md"]');
  await page.waitForFunction(() => document.querySelector('#doc-body h1'), { timeout: 5000 });
  const md1 = await page.evaluate(() => {
    const b = document.getElementById('doc-body');
    const c = (s) => b.querySelectorAll(s).length;
    return { name: document.getElementById('doc-name').textContent, h1: c('h1'), strong: c('strong'), tr: c('table tr'), li: c('li'), code: c('pre code'), hl: c('pre code .hljs-keyword, pre code[class*="hljs"]') };
  });
  if (md1.name !== 'report.md' || md1.h1 !== 1 || md1.strong !== 1 || md1.tr !== 3 || md1.li !== 2 || md1.code !== 1) {
    throw new Error('markdown preview wrong: ' + JSON.stringify(md1));
  }
  if (!md1.hl) throw new Error('code in the preview was not highlighted: ' + JSON.stringify(md1));

  // 2. Escape closes it and clears the body
  await page.keyboard.press('Escape');
  if (await shown()) throw new Error('Escape did not close the preview');
  if (await page.evaluate(() => document.getElementById('doc-body').innerHTML) !== '') throw new Error('closed preview kept its body');

  // 3. a .txt opens verbatim: no markdown, no HTML
  await page.click('button.attachment[data-name="notes.txt"]');
  await page.waitForFunction(() => document.querySelector('#doc-body pre.doc-plain'), { timeout: 5000 });
  const t = await page.evaluate(() => ({ text: document.querySelector('#doc-body pre.doc-plain').textContent, b: document.querySelectorAll('#doc-body b, #doc-body h1').length }));
  if (t.text !== TXT || t.b !== 0) throw new Error('text preview wrong: ' + JSON.stringify(t));

  // 4. the backdrop click closes; the Download button is still there for the file itself
  const hasDl = await page.evaluate(() => !!document.getElementById('doc-dl'));
  if (!hasDl) throw new Error('preview lost its Download button');
  await page.mouse.click(5, 5);
  if (await shown()) throw new Error('backdrop click did not close the preview');

  await browser.close();
  console.log('DOCPREVIEW_CHECK_OK');
})().catch((e) => { console.error('DOCPREVIEW_CHECK_FAIL:', e.message); process.exit(1); });
