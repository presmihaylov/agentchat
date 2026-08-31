// E2E for the surgical live-update fix: a thread reply, an edit, and a delete
// must each touch only the target message node, never wholesale-refetch the
// channel. We tag a bystander node (B) with a DOM expando; a full refetch
// re-creates every node and wipes the expando, so its survival is the signal.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/msgsync-check.js
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
  const created = await api('/api/v1/rooms', { method: 'POST', body: { name: 'msgsync check' } });
  const slug = created.room.slug;
  const bot = await api('/api/v1/rooms/join', { method: 'POST', body: { invite_code: created.invite_code, name: 'syncbot', description: 't', avatar: '🤖' } });
  const A = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'alpha original' } });
  const B = await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'bravo keep' } });

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(SERVER + '/r/' + slug, { waitUntil: 'networkidle2' });
  await page.type('#join-code', created.invite_code);
  await page.type('#join-name', 'humantester');
  await page.click('#join-form button[type=submit]');
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 5000 });

  const node = (id) => `[...document.querySelectorAll('#messages .msg')].find(n => n.dataset.id === ${JSON.stringify(id)})`;

  // both messages present; stamp a survivable expando on B
  await page.waitForFunction(`${node(A.id)} && ${node(B.id)}`, { timeout: 8000 });
  await page.evaluate(`${node(B.id)}.__sentinel = 'keep-me'`);
  const stamped = await page.evaluate(`${node(B.id)}.__sentinel`);
  if (stamped !== 'keep-me') throw new Error('failed to stamp B');

  // 1) thread reply to A: A gains a reply bar, B is untouched
  await api('/api/v1/channels/general/messages', { method: 'POST', token: bot.token, body: { body: 'a thread reply', thread_root_id: A.id } });
  await page.waitForFunction(`${node(A.id)} && ${node(A.id)}.querySelector('button.reply-bar')`, { timeout: 8000 });
  if (await page.evaluate(`${node(B.id)}.__sentinel`) !== 'keep-me')
    throw new Error('thread reply wiped the channel (B re-rendered)');

  // 2) edit A: only A's node is replaced, B keeps its expando
  await api('/api/v1/messages/' + A.id, { method: 'PATCH', token: bot.token, body: { body: 'alpha edited' } });
  await page.waitForFunction(`${node(A.id)} && ${node(A.id)}.textContent.includes('alpha edited')`, { timeout: 8000 });
  if (await page.evaluate(`${node(B.id)}.__sentinel`) !== 'keep-me')
    throw new Error('edit wiped the channel (B re-rendered)');

  // 3) delete A: A's node vanishes, B stays present and stamped
  await api('/api/v1/messages/' + A.id, { method: 'DELETE', token: bot.token });
  await page.waitForFunction(`!(${node(A.id)})`, { timeout: 8000 });
  if (await page.evaluate(`!(${node(B.id)}) || ${node(B.id)}.__sentinel !== 'keep-me'`))
    throw new Error('delete disturbed B');

  await browser.close();
  console.log('MSGSYNC_CHECK_OK');
})().catch((e) => { console.error('MSGSYNC_CHECK_FAIL:', e.message); process.exit(1); });
