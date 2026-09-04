// E2E: a "```lang" fence line in the composer opens a real code block on
// Shift-Enter and on Enter (Maya FR, tablinum-style), after a hard break too;
// Tab indents inside it; ⌘Enter sends the block as fenced markdown.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/codeblock-check.js
const puppeteer = require('puppeteer-core');
const { newRoom, enterAs } = require('./lib/login.js');
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
  const created = await newRoom(SERVER, 'codeblock check');
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'fencebot', description: 't', avatar: '🤖' } });

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await enterAs(page, SERVER, slug, created.invite_code, 'fencer');
  await page.click('#composer-input');

  const state = () => page.evaluate(() => {
    const ed = document.querySelector('#composer-input').__composer.editor;
    return {
      md: ed.getMarkdown().trim(),
      inCode: ed.isActive('codeBlock'),
      lang: ed.getAttributes('codeBlock').language || null,
      // StarterKit keeps an empty trailing paragraph after a code block (the
      // way out of it); it is not content and send() trims it
      blocks: ed.state.doc.content.content.filter((n) => n.content.size > 0 || n.type.name === 'codeBlock').length,
    };
  });
  const shiftEnter = async () => {
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  };
  const sent = async () => {
    const data = await api('/api/v1/channels/general/messages?limit=5', { token: bot.token });
    return (data.messages || data).filter((m) => m.kind !== 'system');
  };

  // 1. "```js" + Shift-Enter at the start of the message: the paragraph becomes
  //    the code block, the marker is gone, the language is kept
  await page.type('#composer-input', '```js');
  await shiftEnter();
  let st = await state();
  if (!st.inCode || st.lang !== 'js') throw new Error('Shift-Enter did not open a js code block: ' + JSON.stringify(st));
  if (st.md.includes('```js```') || /```js\s*```js/.test(st.md)) throw new Error('fence marker left behind: ' + JSON.stringify(st));

  // 2. Tab indents two spaces, Enter is a newline inside the block, nothing sends
  await page.keyboard.press('Tab');
  await page.type('#composer-input', 'let a = 1;');
  await page.keyboard.press('Enter');
  await page.type('#composer-input', 'a > 0');
  st = await state();
  if (!st.inCode) throw new Error('Enter left the code block: ' + JSON.stringify(st));
  if (!st.md.includes('  let a = 1;\na > 0')) throw new Error('Tab/Enter inside the block wrong: ' + JSON.stringify(st));
  const before = (await sent()).length;

  // 3. ⌘Enter sends the block as fenced markdown, verbatim
  await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
  // the feed paints optimistically, so wait on the server, not the DOM
  let msgs = [];
  for (let i = 0; i < 40 && msgs.length <= before; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    msgs = await sent();
  }
  if (msgs.length <= before) throw new Error('⌘Enter did not send the block');
  const last = msgs.sort((a, b) => a.created_at.localeCompare(b.created_at))[msgs.length - 1].body;
  if (last !== '```js\n  let a = 1;\na > 0\n```') throw new Error('sent body wrong: ' + JSON.stringify(last));
  if (!(await page.$('#messages .msg pre code'))) throw new Error('feed did not render the block as <pre><code>');

  // 4. a fence after a hard break: the text before it stays a paragraph, the
  //    block follows; plain Enter opens it too (it used to send "```")
  await page.click('#composer-input');
  await page.type('#composer-input', 'see this:');
  await shiftEnter();
  await page.type('#composer-input', '```');
  await page.keyboard.press('Enter');
  st = await state();
  if (!st.inCode || st.lang !== null || st.blocks !== 2) throw new Error('fence after a break wrong: ' + JSON.stringify(st));
  if ((await sent()).length !== before + 1) throw new Error('plain Enter on a fence line sent a message');
  await page.type('#composer-input', 'x');
  st = await state();
  if (st.md !== 'see this:\n\n```\nx\n```') throw new Error('markdown after a break wrong: ' + JSON.stringify(st));

  // 5. "```py " (space) after a hard break opens one too, like at the start
  await page.evaluate(() => document.querySelector('#composer-input').__composer.clear());
  await page.type('#composer-input', 'and');
  await shiftEnter();
  await page.type('#composer-input', '```py ');
  st = await state();
  if (!st.inCode || st.lang !== 'py' || st.blocks !== 2) throw new Error('space rule after a break wrong: ' + JSON.stringify(st));

  // 6. a lone Shift-Enter on ordinary text is still a soft break
  await page.evaluate(() => document.querySelector('#composer-input').__composer.clear());
  await page.type('#composer-input', 'plain');
  await shiftEnter();
  await page.type('#composer-input', 'text');
  st = await state();
  if (st.md !== 'plain\ntext' || st.inCode) throw new Error('soft break regressed: ' + JSON.stringify(st));

  await browser.close();
  console.log('CODEBLOCK_CHECK_OK');
})().catch((e) => { console.error('CODEBLOCK_CHECK_FAIL:', e.message); process.exit(1); });
