// End-to-end: loads the unpacked extension into Chrome for Testing and drives
// a mock claude.ai through the scenarios a user would hit.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { CHATS, SESSIONS, createServer } from './mock-claude.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = path.join(root, 'tests/artifacts');
const [chatA, chatB, chatC] = CHATS.map((c) => c.uuid);
const [codeA, codeB] = SESSIONS.map((s) => s.id);

let browser;
let server;
let extensionId;

async function openApp(urlPath) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 640 });
  await page.setRequestInterception(true);
  page.on('request', (req) => server.handle(req).catch(() => {}));
  await page.goto(`https://claude.ai${urlPath}`);
  await page.waitForSelector('nav a');
  return page;
}

// Current state of the row containing the link to `id`.
function rowState(page, id) {
  return page.$eval(`nav a[href$="${id}"]`, (a) => {
    const row = a.closest('[data-sl-row]');
    if (!row) return 'unstyled';
    return row.getAttribute('data-sl-state') || 'idle';
  });
}

async function waitState(page, id, state, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await rowState(page, id).catch(() => 'missing');
    if (last === state) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.fail(`expected ${id} to be "${state}" within ${timeout}ms, last saw "${last}"`);
}

async function click(page, id) {
  await page.click(`nav a[href$="${id}"]`);
}

describe('session lights e2e', () => {
  before(async () => {
    await mkdir(artifacts, { recursive: true });
    server = createServer();
    browser = await puppeteer.launch({
      headless: true,
      pipe: true,
      enableExtensions: [root],
      args: ['--window-size=1100,700'],
    });
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'));
    extensionId = new URL(sw.url()).host;
  });

  after(async () => {
    // browser.close() can stall on in-flight intercepted requests; don't let it hang the run.
    const proc = browser?.process();
    await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 5000))]);
    proc?.kill('SIGKILL');
  });

  test('rows are recognized and styled hooks are attached', async () => {
    const page = await openApp(`/chat/${chatA}`);
    for (const id of [chatA, chatB, chatC, codeA, codeB]) await waitState(page, id, 'idle');
    // Full-width links are painted directly so the tint follows their rounded corners.
    const tag = await page.$eval(`nav a[href$="${chatB}"]`, (a) => a.closest('[data-sl-row]').tagName);
    assert.equal(tag, 'A');
    await page.close();
  });

  test('Claude Code session: running -> unread -> seen', async () => {
    server.state.sessionStatus[codeA] = 'running';
    const page = await openApp(`/chat/${chatA}`);
    await waitState(page, codeA, 'running');
    await waitState(page, codeB, 'idle');
    await page.screenshot({ path: path.join(artifacts, 'code-running.png') });

    // The app fetched /v1/sessions once; the extension's poll notices the flip.
    server.state.sessionStatus[codeA] = 'idle';
    server.state.sessionUpdated[codeA] = new Date().toISOString();
    await waitState(page, codeA, 'unread', 12000);
    await page.screenshot({ path: path.join(artifacts, 'code-unread.png') });

    await click(page, codeA);
    await waitState(page, codeA, 'idle');
    // Leaving it again keeps it read.
    await click(page, chatA);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await rowState(page, codeA), 'idle');
    await page.close();
  });

  test('chat: finishes while you are elsewhere -> unread; finishes while watching -> default', async () => {
    const page = await openApp(`/chat/${chatB}`);
    server.state.completionDelayMs = 2500;
    await page.click('#send');
    await waitState(page, chatB, 'running');
    await click(page, chatC);
    await waitState(page, chatB, 'running');
    await page.screenshot({ path: path.join(artifacts, 'chat-running.png') });
    await waitState(page, chatB, 'unread', 6000);

    // Watching chat C the whole time it runs: never turns green.
    server.state.completionDelayMs = 1500;
    await page.click('#send');
    await waitState(page, chatC, 'running');
    await waitState(page, chatC, 'idle', 5000);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(await rowState(page, chatC), 'idle');
    await page.screenshot({ path: path.join(artifacts, 'chat-mixed.png') });

    // Persisted across reloads.
    await page.reload();
    await page.waitForSelector('nav a');
    await waitState(page, chatB, 'unread');
    await page.close();
  });

  test('chat: stream aborted by navigation stays running until the server finishes', async () => {
    const page = await openApp(`/chat/${chatA}`);
    await page.evaluate(() => (window.__abortOnLeave = true));
    server.state.completionDelayMs = 6000;
    await page.click('#send');
    await waitState(page, chatA, 'running');
    await click(page, chatC); // aborts the fetch; server keeps generating
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(await rowState(page, chatA), 'running');
    // Detail endpoint reports the assistant message once the delay elapses.
    await waitState(page, chatA, 'unread', 20000);
    await page.close();
  });

  test('cross-tab: another tab sees running and unread', async () => {
    const pageA = await openApp(`/chat/${chatC}`);
    const pageB = await openApp(`/chat/${chatC}`);
    server.state.completionDelayMs = 3000;
    await pageA.bringToFront();
    await pageA.click('#send');
    await waitState(pageB, chatC, 'running');
    // Both tabs show chat C, so finishing while viewed leaves it read.
    await waitState(pageB, chatC, 'idle', 8000);
    await pageA.close();
    await pageB.close();
  });

  test('popup and badge reflect stored state', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 340, height: 600 });
    await page.goto(`chrome-extension://${extensionId}/src/popup.html`);
    await page.waitForFunction(() => document.querySelector('#n-unread').textContent !== '0');
    const unread = Number(await page.$eval('#n-unread', (el) => el.textContent));
    assert.ok(unread >= 2, `expected >= 2 unread, got ${unread}`);
    const titles = await page.$$eval('#list .title', (els) => els.map((e) => e.textContent));
    assert.ok(titles.includes('Explain the flaky CI job'), titles.join(', '));
    await page.screenshot({ path: path.join(artifacts, 'popup.png'), fullPage: true });

    const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extensionId))).worker();
    await new Promise((r) => setTimeout(r, 500));
    const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    assert.equal(badge, String(unread));

    await page.click('#mark-all');
    await page.waitForFunction(() => document.querySelector('#n-unread').textContent === '0');
    assert.equal(await page.$eval('#empty', (el) => el.hidden), false);
    await page.close();
  });

  test('settings: disabling chats removes chat styling', async () => {
    const page = await openApp(`/chat/${chatA}`);
    await waitState(page, chatA, 'idle');
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup.html`);
    await popup.click('input[data-setting="chats"] + .sw');
    await popup.close();
    await page.bringToFront();
    await waitState(page, chatA, 'unstyled');
    await waitState(page, codeA, 'idle');
    await page.close();
  });
});
