// Isolated-world content script. Decides each session's state and paints it
// onto session links (sidebar, recents lists) as `data-sl-state` attributes
// that content.css styles. It never inserts nodes into the app's React tree.
//
// State per session (see SL.stateOf):
//   running - some tab currently observes it running (red)
//   unread  - it was active after you last looked at it (green)
//   idle    - everything else (default look)
(() => {
  'use strict';
  const SL = globalThis.SL;
  const TAG = '__sessionLights';

  const API_RUNNING_TTL_MS = 3 * 60 * 1000;
  const SEEN_REFRESH_MS = 2000;
  const ROW_MAX_HEIGHT = 84;
  const STATE_RANK = { running: 2, unread: 1, idle: 0 };

  // Session links inside rendered message content are not navigation.
  const EXCLUDE_SEL = '.prose, [class*="prose"], [data-is-streaming], [data-testid*="message"], .font-claude-message, [contenteditable]';
  // Native busy indicators the app may render inside a session row.
  const SPINNER_SEL = [
    '[class*="animate-spin"]',
    '[class*="animate-pulse"]',
    '[class*="spinner" i]',
    '[role="progressbar"]',
    '[aria-busy="true"]',
    '[data-state="running"]',
    '[data-status="running"]',
  ].join(',');
  const BUSY_LABEL = /\b(running|in progress|working|generating|responding|thinking)\b/i;

  /** @type {Map<string, object>} id -> persisted record (mirror of storage) */
  const records = new Map();
  /** @type {Map<string, {stream:boolean, api:{running:boolean, at:number}|null, dom:boolean, page:boolean}>} */
  const live = new Map();
  const wasLocalRunning = new Set();
  const lastBeat = new Map();
  let settings = { ...SL.DEFAULT_SETTINGS };
  let ready = false;
  let styled = new Map(); // element -> state

  const log = (...a) => settings.debug && console.debug('[session-lights]', ...a);

  // ------------------------------------------------------------ storage
  // Patches made during one tick are written together right after it, so a
  // tab closing immediately afterwards doesn't lose them.
  const pending = new Map();
  let flushQueued = false;

  function patch(id, changes) {
    const base = records.get(id) || { id, firstSeenAt: Date.now(), seenAt: 0, lastActivityAt: 0, runningUntil: 0 };
    const next = { ...base, ...changes };
    records.set(id, next);
    pending.set(id, next);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
  }

  function flush() {
    flushQueued = false;
    if (!pending.size) return;
    const batch = {};
    for (const [id, rec] of pending) batch[SL.recordKey(id)] = rec;
    pending.clear();
    try {
      chrome.storage.local.set(batch);
    } catch {
      // Extension was reloaded; this content script is orphaned.
      teardown();
    }
  }

  function liveOf(id) {
    let l = live.get(id);
    if (!l) {
      l = { stream: false, api: null, dom: false, page: false };
      live.set(id, l);
    }
    return l;
  }

  function localRunning(id, now) {
    const l = live.get(id);
    if (!l) return false;
    return l.stream || l.dom || l.page || !!(l.api && l.api.running && now - l.api.at < API_RUNNING_TTL_MS);
  }

  // ------------------------------------------------------------ viewing
  function routeSession() {
    return SL.parseSessionPath(location.pathname);
  }

  function viewingId() {
    const r = routeSession();
    return r && document.visibilityState === 'visible' ? r.id : null;
  }

  function markSeen(id, now) {
    const rec = records.get(id);
    if (!rec) return;
    const target = Math.max(now, (rec.lastActivityAt || 0) + 1);
    if (target - (rec.seenAt || 0) >= SEEN_REFRESH_MS || (rec.lastActivityAt || 0) >= (rec.seenAt || 0)) {
      patch(id, { seenAt: target });
    }
  }

  // ------------------------------------------------------------ page signals
  function pageIsStreaming() {
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    for (const b of document.querySelectorAll('button[aria-label]')) {
      const label = b.getAttribute('aria-label');
      if (/^(stop|stop response|stop generating|interrupt|stop claude)$/i.test(label.trim()) && b.offsetParent && !b.closest('nav, aside')) {
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ messages from inject.js
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'inject') return;
    const msg = e.data;
    const now = Date.now();
    if (msg.type === 'stream') {
      liveOf(msg.id).stream = !!msg.running;
      log('stream', msg.id, msg.running);
    } else if (msg.type === 'reports') {
      const viewing = viewingId();
      for (const r of msg.reports) {
        if (r.running !== null) liveOf(r.id).api = { running: r.running, at: now };
        const rec = records.get(r.id);
        // Server-side activity we did not witness (e.g. finished while no tab was open).
        if (rec && r.updatedAt && r.id !== viewing && r.updatedAt <= now + 5000 &&
            r.updatedAt > (rec.firstSeenAt || 0) && r.updatedAt > (rec.seenAt || 0) + 1500 &&
            r.updatedAt > (rec.lastActivityAt || 0)) {
          patch(r.id, { lastActivityAt: Math.min(r.updatedAt, now) });
        }
      }
      log('reports', msg.source, msg.reports);
    }
    schedule();
  });

  // ------------------------------------------------------------ tick
  // Reconciles live signals with persisted records: heartbeats while running,
  // a completion stamp when running stops, and "seen" while you look at it.
  function tick() {
    if (!ready) return;
    const now = Date.now();
    const route = routeSession();
    const viewing = viewingId();

    if (route) {
      const streaming = pageIsStreaming();
      for (const [id, l] of live) if (l.page && id !== route.id) l.page = false;
      if (streaming || live.has(route.id)) liveOf(route.id).page = streaming;
      if (!records.has(route.id)) patch(route.id, { kind: route.kind, path: location.pathname });
    } else {
      for (const l of live.values()) l.page = false;
    }

    const ids = new Set([...live.keys(), ...wasLocalRunning]);
    for (const id of ids) {
      const running = localRunning(id, now);
      if (running) {
        if (!wasLocalRunning.has(id) || now - (lastBeat.get(id) || 0) >= SL.HEARTBEAT_MS) {
          lastBeat.set(id, now);
          patch(id, { runningUntil: now + SL.LEASE_MS, lastActivityAt: now });
        }
        wasLocalRunning.add(id);
      } else if (wasLocalRunning.has(id)) {
        wasLocalRunning.delete(id);
        lastBeat.delete(id);
        patch(id, { runningUntil: 0, lastActivityAt: now });
        log('finished', id);
      }
    }

    if (viewing) markSeen(viewing, now);
    render(now);
  }

  // ------------------------------------------------------------ render
  function rowFor(a) {
    let el = a;
    for (let i = 0; i < 3; i++) {
      const p = el.parentElement;
      if (!p || p === document.body) break;
      if (el.tagName === 'LI') break;
      if (p.querySelectorAll('a[href]').length !== 1) break;
      const h = p.getBoundingClientRect().height;
      if (!h || h > ROW_MAX_HEIGHT) break;
      el = p;
    }
    return el;
  }

  // Paint the link itself when it spans the row: it usually carries the app's
  // own rounded hover/active background, so our tint lines up with it.
  function paintTarget(a, row) {
    if (row === a) return a;
    const aw = a.getBoundingClientRect().width;
    return aw >= row.getBoundingClientRect().width * 0.7 ? a : row;
  }

  function nativeBusy(row) {
    for (const el of row.querySelectorAll(SPINNER_SEL)) {
      if (el.getBoundingClientRect().width > 0) return true;
    }
    for (const el of row.querySelectorAll('[role="status"][aria-label], svg[aria-label], [data-testid*="status"][aria-label]')) {
      if (BUSY_LABEL.test(el.getAttribute('aria-label'))) return true;
    }
    return false;
  }

  function render(now) {
    const next = new Map();
    const busyIds = new Set();
    const rows = [];
    const route = routeSession();
    for (const a of document.querySelectorAll('a[href]')) {
      let url;
      try {
        url = new URL(a.getAttribute('href'), location.href);
      } catch {
        continue;
      }
      if (url.origin !== location.origin) continue;
      const s = SL.parseSessionPath(url.pathname);
      if (!s) continue;
      if ((s.kind === 'chat' && !settings.chats) || (s.kind === 'code' && !settings.code)) continue;
      if (a.closest(EXCLUDE_SEL)) continue;

      const row = rowFor(a);
      if (nativeBusy(row)) busyIds.add(s.id);
      rows.push([a, paintTarget(a, row), s, url]);
    }

    for (const [id, l] of live) l.dom = busyIds.has(id);
    for (const id of busyIds) liveOf(id).dom = true;

    for (const [a, row, s, url] of rows) {
      const rec = records.get(s.id);
      const title = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140);
      if (!rec) {
        patch(s.id, { kind: s.kind, path: url.pathname, title });
      } else if ((title && rec.title !== title) || rec.path !== url.pathname) {
        patch(s.id, { title: title || rec.title, path: url.pathname, kind: s.kind });
      }

      let state = SL.stateOf(records.get(s.id), now, localRunning(s.id, now));
      // The session on screen is being looked at; never call it unread.
      if (state === 'unread' && route && route.id === s.id && document.visibilityState === 'visible') state = 'idle';
      // Two links may share a row; running beats unread beats idle.
      if (!next.has(row) || STATE_RANK[state] > STATE_RANK[next.get(row)]) next.set(row, state);
    }

    for (const [el] of styled) if (!next.has(el)) clearRow(el);
    for (const [el, state] of next) {
      el.setAttribute('data-sl-row', '');
      if (state === 'running' || state === 'unread') {
        if (el.getAttribute('data-sl-state') !== state) el.setAttribute('data-sl-state', state);
      } else if (el.hasAttribute('data-sl-state')) {
        el.removeAttribute('data-sl-state');
      }
    }
    styled = next;
  }

  function clearRow(el) {
    el.removeAttribute('data-sl-state');
    el.removeAttribute('data-sl-row');
  }

  // ------------------------------------------------------------ scheduling
  // Streaming replies mutate the DOM every frame; cap re-renders at ~4/s.
  const MIN_RENDER_GAP_MS = 250;
  let scheduled = 0;
  let lastRun = 0;
  function schedule() {
    if (scheduled) return;
    const wait = Math.max(0, lastRun + MIN_RENDER_GAP_MS - Date.now());
    scheduled = setTimeout(() => {
      requestAnimationFrame(() => {
        scheduled = 0;
        lastRun = Date.now();
        tick();
      });
    }, wait);
  }

  // Our own data-sl-* writes are outside attributeFilter, so they don't loop.
  const observer = new MutationObserver(schedule);

  let interval = 0;
  const onVisibility = () => schedule();

  function applySettings() {
    const cl = document.documentElement.classList;
    cl.toggle('sl-tint', !!settings.tint);
    cl.toggle('sl-animate', !!settings.animate);
    cl.toggle('sl-debug', !!settings.debug);
  }

  function onStorage(changes, area) {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === SL.SETTINGS_KEY) {
        settings = SL.settingsFrom({ [SL.SETTINGS_KEY]: newValue });
        applySettings();
      } else if (key.startsWith(SL.RECORD_PREFIX)) {
        const id = key.slice(SL.RECORD_PREFIX.length);
        if (pending.has(id)) continue; // our own unflushed write is newer
        if (newValue) records.set(id, newValue);
        else records.delete(id);
      }
    }
    schedule();
  }

  function teardown() {
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(scheduled);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const [el] of styled) clearRow(el);
    styled = new Map();
  }

  async function start() {
    const all = await chrome.storage.local.get(null);
    settings = SL.settingsFrom(all);
    for (const rec of SL.recordsFrom(all)) records.set(rec.id, rec);
    ready = true;
    applySettings();
    chrome.storage.onChanged.addListener(onStorage);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href', 'class', 'aria-busy', 'aria-label', 'data-is-streaming', 'data-state', 'data-status'],
    });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('popstate', schedule);
    window.addEventListener('focus', schedule);
    window.addEventListener('pagehide', flush);
    // Expiring leases and TTLs need a clock even when the DOM is quiet.
    interval = setInterval(tick, 1000);
    schedule();
  }

  start().catch((err) => console.warn('[session-lights] failed to start', err));
})();
