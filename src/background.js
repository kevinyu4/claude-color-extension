// Toolbar badge: number of running sessions (red), else unread ones (green).
importScripts('shared.js');

const COLORS = { running: '#ff4d5e', unread: '#22d681' };

async function refresh() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  let running = 0;
  let unread = 0;
  for (const rec of SL.recordsFrom(all)) {
    const state = SL.stateOf(rec, now, false);
    if (state === 'running') running++;
    else if (state === 'unread') unread++;
  }
  const [text, color] = running ? [String(running), COLORS.running] : unread ? [String(unread), COLORS.unread] : ['', COLORS.unread];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#0b0f14' });
  await chrome.action.setTitle({ title: `Session Lights - ${running} running, ${unread} unread` });
}

async function prune() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - SL.RECORD_TTL_MS;
  const stale = SL.recordsFrom(all)
    .filter((r) => Math.max(r.seenAt || 0, r.lastActivityAt || 0, r.firstSeenAt || 0) < cutoff)
    .map((r) => SL.recordKey(r.id));
  if (stale.length) await chrome.storage.local.remove(stale);
}

// Leases expire without a storage write, so also refresh on a timer.
let pendingRefresh = 0;
function scheduleRefresh() {
  clearTimeout(pendingRefresh);
  pendingRefresh = setTimeout(() => refresh().catch(() => {}), 200);
}

chrome.storage.onChanged.addListener((_changes, area) => area === 'local' && scheduleRefresh());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh') scheduleRefresh();
  if (alarm.name === 'prune') prune().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: 0.5 });
  chrome.alarms.create('prune', { periodInMinutes: 24 * 60 });
  scheduleRefresh();
});
chrome.runtime.onStartup.addListener(scheduleRefresh);
