'use strict';

const $ = (sel) => document.querySelector(sel);
const ORIGIN = 'https://claude.ai';

let all = {};

function ago(ts, now) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function render() {
  const now = Date.now();
  const settings = SL.settingsFrom(all);
  const enabled = (rec) => (rec.kind === 'code' ? settings.code : settings.chats);
  const recs = SL.recordsFrom(all).filter(enabled);
  const byState = { running: [], unread: [], idle: [] };
  for (const rec of recs) byState[SL.stateOf(rec, now, false)].push(rec);

  for (const k of Object.keys(byState)) {
    $(`#n-${k}`).textContent = byState[k].length;
    $(`.stat.${k}`).classList.toggle('live', byState[k].length > 0);
  }
  $('#mark-all').disabled = byState.unread.length === 0;

  const items = [
    ...byState.running.sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((r) => ['running', r]),
    ...byState.unread.sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((r) => ['unread', r]),
  ];
  // Rebuild only on change so hover/focus survive the 1s refresh.
  const sig = JSON.stringify(items.map(([st, r]) => [st, r.id, r.title, ago(r.lastActivityAt, now)]));
  const list = $('#list');
  if (sig !== list.dataset.sig) {
    list.dataset.sig = sig;
    list.replaceChildren(...items.map(([state, rec]) => itemFor(state, rec, now)));
  }
  $('#empty').hidden = items.length > 0;

  for (const input of document.querySelectorAll('[data-setting]')) {
    input.checked = !!settings[input.dataset.setting];
  }
}

function itemFor(state, rec, now) {
  const li = $('#item-tpl').content.firstElementChild.cloneNode(true);
  const btn = li.querySelector('.item');
  btn.classList.add(state);
  btn.title = rec.title || rec.id;
  li.querySelector('.title').textContent = rec.title || 'Untitled session';
  li.querySelector('.kind').textContent = rec.kind === 'code' ? 'code' : 'chat';
  li.querySelector('.ago').textContent = state === 'running' ? 'live' : ago(rec.lastActivityAt, now);
  btn.addEventListener('click', () => openSession(rec));
  return li;
}

async function openSession(rec) {
  const path = rec.path || (rec.kind === 'code' ? `/code/${rec.id}` : `/chat/${rec.id}`);
  const url = ORIGIN + path;
  const tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((t) => t.url && new URL(t.url).pathname === path) ||
    tabs.find((t) => current[0] && t.id === current[0].id) ||
    tabs.find((t) => current[0] && t.windowId === current[0].windowId) ||
    tabs[0];
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true, ...(new URL(tab.url).pathname === path ? {} : { url }) });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

async function markAllRead() {
  const now = Date.now();
  const batch = {};
  for (const rec of SL.recordsFrom(all)) {
    if (SL.stateOf(rec, now, false) === 'unread') batch[SL.recordKey(rec.id)] = { ...rec, seenAt: now };
  }
  await chrome.storage.local.set(batch);
}

async function setSetting(name, value) {
  const settings = { ...SL.settingsFrom(all), [name]: value };
  await chrome.storage.local.set({ [SL.SETTINGS_KEY]: settings });
}

async function main() {
  all = await chrome.storage.local.get(null);
  render();
  chrome.storage.onChanged.addListener(async (_c, area) => {
    if (area !== 'local') return;
    all = await chrome.storage.local.get(null);
    render();
  });
  $('#mark-all').addEventListener('click', markAllRead);
  for (const input of document.querySelectorAll('[data-setting]')) {
    input.addEventListener('change', () => setSetting(input.dataset.setting, input.checked));
  }
  setInterval(render, 1000);
}

main();
