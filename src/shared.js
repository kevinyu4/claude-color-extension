// Shared between the content script, popup and background worker.
// Loaded as a classic script; exposes `globalThis.SL`.
(function (root) {
  'use strict';

  const RECORD_PREFIX = 's:';
  const SETTINGS_KEY = 'settings';

  const DEFAULT_SETTINGS = Object.freeze({
    chats: true, // color regular claude.ai chats / tasks
    code: true, // color Claude Code sessions
    tint: true, // row background tint in addition to the accent bar
    animate: true, // pulse + shimmer on running rows
    debug: false, // outline detected rows and log detection to the console
  });

  // A tab that knows a session is running re-asserts it every HEARTBEAT_MS.
  // Other tabs (and the badge) treat it as running until the lease expires.
  const HEARTBEAT_MS = 5000;
  const LEASE_MS = 15000;

  // Records untouched for this long are pruned.
  const RECORD_TTL_MS = 45 * 24 * 3600 * 1000;

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SESSION_PATH = /^\/(chat|chats|task|tasks|code|session|sessions)\/([A-Za-z0-9_-]{8,})\/?$/;

  // Parses a claude.ai path into { kind, id } or null when it is not a session link.
  function parseSessionPath(pathname) {
    const m = SESSION_PATH.exec(pathname || '');
    if (!m) return null;
    const id = m[2];
    const idLike = UUID.test(id) || /^session_/.test(id) || (id.length >= 12 && /\d/.test(id));
    if (!idLike) return null;
    return { kind: m[1] === 'code' || /^session_/.test(id) ? 'code' : 'chat', id };
  }

  // 'running' | 'unread' | 'idle'
  function stateOf(rec, now, localRunning) {
    if (localRunning) return 'running';
    if (!rec) return 'idle';
    if ((rec.runningUntil || 0) > now) return 'running';
    if ((rec.lastActivityAt || 0) > (rec.seenAt || 0)) return 'unread';
    return 'idle';
  }

  function recordKey(id) {
    return RECORD_PREFIX + id;
  }

  function recordsFrom(all) {
    const out = [];
    for (const [k, v] of Object.entries(all || {})) {
      if (k.startsWith(RECORD_PREFIX) && v && typeof v === 'object') out.push(v);
    }
    return out;
  }

  function settingsFrom(all) {
    return { ...DEFAULT_SETTINGS, ...((all && all[SETTINGS_KEY]) || {}) };
  }

  root.SL = Object.freeze({
    RECORD_PREFIX,
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    HEARTBEAT_MS,
    LEASE_MS,
    RECORD_TTL_MS,
    parseSessionPath,
    stateOf,
    recordKey,
    recordsFrom,
    settingsFrom,
  });
})(globalThis);
