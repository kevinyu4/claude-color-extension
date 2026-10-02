// Renders docs/sidebar.png and docs/popup.png from the mock claude.ai with
// every state on screen: running code session, running chat, unread, idle.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { CHATS, SESSIONS, createServer } from '../tests/mock-claude.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer();
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [root] });
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const extensionId = new URL(sw.url()).host;

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 330, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', (req) => server.handle(req).catch(() => {}));
  await page.goto(`https://claude.ai/chat/${CHATS[1].uuid}`);
  await page.waitForSelector('nav a');

  // Chat 2 finishes while we're elsewhere -> unread.
  server.state.completionDelayMs = 800;
  await page.click('#send');
  await sleep(150);
  await page.click(`nav a[href$="${CHATS[2].uuid}"]`);
  await sleep(1500);
  // Code session 2 becomes unread, session 1 runs; chat 1 runs in the background.
  server.state.sessionStatus[SESSIONS[1].id] = 'running';
  await page.reload();
  await page.waitForSelector('nav a');
  await sleep(1500);
  server.state.sessionStatus[SESSIONS[1].id] = 'idle';
  server.state.sessionUpdated[SESSIONS[1].id] = new Date().toISOString();
  server.state.sessionStatus[SESSIONS[0].id] = 'running';
  await sleep(6000);
  await page.click(`nav a[href$="${CHATS[0].uuid}"]`);
  server.state.completionDelayMs = 60000;
  page.click('#send');
  await sleep(300);
  await page.click(`nav a[href$="${CHATS[2].uuid}"]`);
  await sleep(1300);
  await page.screenshot({ path: path.join(root, 'docs/sidebar.png'), clip: { x: 0, y: 0, width: 300, height: 300 } });

  const popup = await browser.newPage();
  await popup.setViewport({ width: 340, height: 520, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup.html`);
  await sleep(500);
  const height = await popup.evaluate(() => document.body.scrollHeight);
  await popup.screenshot({ path: path.join(root, 'docs/popup.png'), clip: { x: 0, y: 0, width: 340, height } });
  console.log('screenshots written');
} finally {
  const proc = browser.process();
  await Promise.race([browser.close(), sleep(3000)]);
  proc?.kill('SIGKILL');
}
