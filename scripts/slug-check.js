// E2E for the slug preview on Create workspace (task 16): the slug follows the
// name until edited by hand, creation lands on /w/<slug>, and a taken slug is
// a clear error in the form with no automatic suffix.
// Run: NODE_PATH=<dir with puppeteer-core> SERVER=http://localhost:8095 OUT=<dir> node scripts/slug-check.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { loginPage, uniqUser } = require('./lib/login.js');
const SERVER = process.env.SERVER || 'http://localhost:8095';
const OUT = process.env.OUT || 'tmp';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let step = 'setup';
let failPage = null;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];
  const page = await browser.newPage();
  failPage = page;
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await loginPage(page, SERVER, uniqUser(), { displayName: 'Sasha Slug' });
  const tag = uniqUser();

  step = '1';
  // 1. the preview follows the name, folded and hyphenated
  await page.goto(SERVER + '/create', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#create-form:not(.hidden)', { timeout: 8000 });
  await page.type('#create-room-name', 'Café Crème ' + tag);
  const preview = await page.$eval('#create-room-slug', (el) => el.value);
  assert(preview === 'cafe-creme-' + tag, 'preview: ' + preview);
  await page.screenshot({ path: path.join(OUT, 'slug-preview.png') });

  step = '2';
  // 2. a hand edit sticks; clearing it hands control back to the name
  await page.$eval('#create-room-slug', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
  await page.type('#create-room-slug', 'custom-' + tag);
  await page.type('#create-room-name', ' more');
  assert(await page.$eval('#create-room-slug', (el) => el.value) === 'custom-' + tag, 'edited slug overwritten');
  await page.$eval('#create-room-slug', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
  await page.type('#create-room-name', ' x');
  assert(await page.$eval('#create-room-slug', (el) => el.value) === 'cafe-creme-' + tag + '-more-x', 'name control not back');

  step = '3';
  // 3. create lands on /w/<slug>
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }), page.click('#create-form button[type=submit]')]);
  assert(new URL(page.url()).pathname === '/w/cafe-creme-' + tag + '-more-x', 'landed on ' + page.url());
  await page.waitForSelector('#chat-view:not(.hidden)', { timeout: 8000 });

  step = '4';
  // 4. the same slug again: a clear error, no suffix, still on /create
  await page.goto(SERVER + '/create', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#create-form:not(.hidden)', { timeout: 8000 });
  await page.type('#create-room-name', 'cafe creme ' + tag + ' more x');
  await page.click('#create-form button[type=submit]');
  await page.waitForSelector('#create-error:not(.hidden)', { timeout: 8000 });
  const err = await page.$eval('#create-error', (el) => el.textContent);
  assert(err.includes('taken'), 'error text: ' + err);
  assert(new URL(page.url()).pathname === '/create', 'left /create on a taken slug');
  await page.screenshot({ path: path.join(OUT, 'slug-taken.png') });

  await browser.close();
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  console.log('SLUG_CHECK_OK');
})().catch(async (e) => {
  console.error('FAIL at step ' + step + ': ' + e.message);
  try { if (failPage) await failPage.screenshot({ path: path.join(OUT, 'slug-fail.png') }); } catch (_) { /* best effort */ }
  process.exit(1);
});
