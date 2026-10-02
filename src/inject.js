// Runs in the page's MAIN world at document_start.
//
// Observes claude.ai's own network traffic to learn which sessions are running:
//   - chat completion streams (POST .../chat_conversations/<uuid>/completion)
//   - JSON / SSE / WebSocket payloads carrying status fields (e.g. Claude Code
//     `session_status: "running" | "idle"` from /v1/sessions)
// and forwards what it learns to the isolated content script via postMessage.
//
// It never modifies requests or responses; it only reads clones.
(() => {
  'use strict';
  if (window.__sessionLightsInjected) return;
  window.__sessionLightsInjected = true;

  const TAG = '__sessionLights';
  const post = (msg) => window.postMessage({ [TAG]: 'inject', ...msg }, location.origin);

  const RUNNING = new Set([
    'running', 'in_progress', 'busy', 'working', 'generating', 'streaming', 'executing',
    'processing', 'thinking', 'rescheduling', 'queued', 'pending', 'starting', 'started',
  ]);
  const IDLE = new Set([
    'idle', 'completed', 'complete', 'done', 'finished', 'succeeded', 'success', 'stopped',
    'cancelled', 'canceled', 'failed', 'error', 'errored', 'terminated', 'ended', 'archived',
    'requires_action', 'waiting_for_input', 'awaiting_input', 'needs_input', 'paused', 'interrupted',
  ]);
  // Status keys trusted on objects that carry their own id.
  const OWN_STATUS_KEYS = ['session_status', 'status', 'state', 'task_status', 'run_status', 'execution_status'];
  // Status keys trusted on id-less objects, attributed to the session named in the URL.
  const CTX_STATUS_KEYS = ['session_status', 'task_status', 'run_status'];
  const BOOL_KEYS = ['is_running', 'is_generating', 'is_streaming', 'is_busy', 'in_progress'];
  const ID_KEYS = ['uuid', 'id'];
  const UPDATED_KEYS = ['updated_at', 'updatedAt', 'last_activity_at', 'last_event_at'];
  const MAX_NODES = 50000;
  const MAX_JSON_BYTES = 8 * 1024 * 1024;

  // Server clock minus local clock, from same-origin `Date` headers. Lets us
  // compare server `updated_at` with locally recorded "last seen" times.
  let clockOffset = 0;

  const COMPLETION_RE = /\/organizations\/([^/]+)\/chat_conversations\/([0-9a-f-]{36})\/(?:retry_)?completion\b/i;
  const CTX_RES = [
    /\/chat_conversations\/([0-9a-f-]{36})/i,
    /\b(session_[A-Za-z0-9]{8,})/,
    /\/(?:sessions|tasks)\/([A-Za-z0-9_-]{12,})/,
  ];

  function ctxIdFromUrl(url) {
    for (const re of CTX_RES) {
      const m = re.exec(url);
      if (m) return m[1];
    }
    return null;
  }

  function isInteresting(url) {
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin && !/(^|\.)anthropic\.com$|(^|\.)claude\.ai$/.test(u.hostname)) return false;
      return /\/(api|v1)\//.test(u.pathname);
    } catch {
      return false;
    }
  }

  function classify(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (RUNNING.has(s)) return true;
    if (IDLE.has(s)) return false;
    return null;
  }

  function toLocalMs(v) {
    if (v == null) return null;
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    return Number.isFinite(t) ? t - clockOffset : null;
  }

  // Walks a JSON payload and collects { id, running, updatedAt, title } reports.
  function collect(root, ctxId) {
    const out = new Map();
    let budget = MAX_NODES;
    const visit = (node, ctx, depth) => {
      if (budget-- <= 0 || depth > 8 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, ctx, depth + 1);
        return;
      }
      let ownId = null;
      for (const k of ID_KEYS) {
        if (typeof node[k] === 'string' && node[k].length >= 8) {
          ownId = node[k];
          break;
        }
      }
      let running = null;
      for (const k of ownId ? OWN_STATUS_KEYS : CTX_STATUS_KEYS) {
        if (k in node) {
          running = classify(node[k]);
          if (running !== null) break;
        }
      }
      if (running === null) {
        for (const k of BOOL_KEYS) {
          if (typeof node[k] === 'boolean') {
            running = node[k];
            break;
          }
        }
      }
      let updatedAt = null;
      if (ownId) {
        for (const k of UPDATED_KEYS) {
          if (node[k] != null) {
            updatedAt = toLocalMs(node[k]);
            break;
          }
        }
      }
      const target = ownId || ctx;
      if (target && (running !== null || updatedAt !== null)) {
        const prev = out.get(target) || { id: target, running: null, updatedAt: null, title: null };
        if (running !== null) prev.running = running;
        if (updatedAt !== null) prev.updatedAt = Math.max(prev.updatedAt || 0, updatedAt);
        const title = ownId && (typeof node.title === 'string' ? node.title : typeof node.name === 'string' ? node.name : null);
        if (title) prev.title = title;
        out.set(target, prev);
      }
      for (const v of Object.values(node)) {
        if (v !== null && typeof v === 'object') visit(v, ownId || ctx, depth + 1);
      }
    };
    visit(root, ctxId, 0);
    return [...out.values()];
  }

  function report(payload, ctxId, source) {
    const reports = collect(payload, ctxId);
    if (reports.length) post({ type: 'reports', source, reports });
    return reports;
  }

  // ---------------------------------------------------------------- streams
  // Active chat completion streams, keyed by conversation uuid.
  const streams = new Map();
  const orphans = new Map();

  function streamStart(id) {
    stopOrphan(id);
    const n = (streams.get(id) || 0) + 1;
    streams.set(id, n);
    if (n === 1) post({ type: 'stream', id, running: true });
  }

  function streamEnd(id, aborted, orgId) {
    const n = (streams.get(id) || 1) - 1;
    if (n > 0) {
      streams.set(id, n);
      return;
    }
    streams.delete(id);
    // The page dropped the stream (e.g. navigated away) but the server keeps
    // generating. Keep it running and poll the conversation until it settles.
    if (aborted && orgId) startOrphan(id, orgId);
    else post({ type: 'stream', id, running: false });
  }

  function startOrphan(id, orgId) {
    const started = Date.now();
    let lastSig = null;
    let stable = 0;
    let failures = 0;
    const url = `/api/organizations/${orgId}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`;
    const tick = async () => {
      if (!orphans.has(id)) return;
      let done = false;
      try {
        const res = await origFetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(String(res.status));
        failures = 0;
        const data = await res.json();
        const msgs = Array.isArray(data.chat_messages) ? data.chat_messages : [];
        const last = msgs[msgs.length - 1];
        const sig = last ? `${last.uuid}:${JSON.stringify(last.content || last.text || '').length}` : '';
        if (last && last.sender === 'assistant' && sig === lastSig) stable++;
        else stable = 0;
        lastSig = sig;
        done = stable >= 2;
      } catch {
        done = ++failures >= 3;
      }
      if (Date.now() - started > 15 * 60 * 1000) done = true;
      if (done) {
        orphans.delete(id);
        post({ type: 'stream', id, running: false });
      } else {
        orphans.set(id, setTimeout(tick, 4000));
      }
    };
    orphans.set(id, setTimeout(tick, 4000));
  }

  function stopOrphan(id) {
    const t = orphans.get(id);
    if (t) clearTimeout(t);
    orphans.delete(id);
  }

  // Reads a cloned SSE body, reporting status fields from each `data:` line.
  async function pumpEventStream(res, ctxId) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data[0] !== '{' && data[0] !== '[') continue;
        try {
          report(JSON.parse(data), ctxId, 'sse');
        } catch {
          /* partial or non-JSON line */
        }
      }
    }
  }

  // ---------------------------------------------------------------- polling
  // GET endpoints that returned explicit session statuses are re-requested
  // periodically (with the same headers the app used), so status flips are
  // noticed even when the app itself stops asking.
  const pollTargets = new Map(); // url -> { headers, failures, lastAppUse }
  let lastRunningSeen = 0;

  function headersToObject(h) {
    const out = {};
    try {
      new Headers(h || {}).forEach((v, k) => (out[k] = v));
    } catch {
      /* ignore */
    }
    return out;
  }

  function rememberPollTarget(url, headers) {
    pollTargets.delete(url);
    pollTargets.set(url, { headers, failures: 0, lastAppUse: Date.now() });
    while (pollTargets.size > 4) pollTargets.delete(pollTargets.keys().next().value);
  }

  async function pollOnce() {
    for (const [url, t] of [...pollTargets]) {
      try {
        const res = await origFetch(url, { headers: t.headers, credentials: 'include' });
        noteDate(res, url);
        if (!res.ok) throw new Error(String(res.status));
        t.failures = 0;
        const reports = report(await res.json(), ctxIdFromUrl(url), 'poll');
        if (reports.some((r) => r.running)) sawRunning();
      } catch {
        if (++t.failures >= 3) pollTargets.delete(url);
      }
    }
  }

  let pollTimer = 0;
  let pollDueAt = Infinity;
  let polling = false;

  // (Re)arms the poll timer; only ever moves the next poll earlier unless `force`.
  function schedulePoll(force) {
    const busy = Date.now() - lastRunningSeen < 60000;
    const delay = document.hidden ? 30000 : busy ? 4000 : 12000;
    const due = Date.now() + delay;
    if (polling || (!force && due >= pollDueAt)) return;
    clearTimeout(pollTimer);
    pollDueAt = due;
    pollTimer = setTimeout(async () => {
      polling = true;
      try {
        if (pollTargets.size) await pollOnce();
      } finally {
        polling = false;
        pollDueAt = Infinity;
        schedulePoll(true);
      }
    }, delay);
  }

  function sawRunning() {
    lastRunningSeen = Date.now();
    schedulePoll(false);
  }
  schedulePoll(true);
  document.addEventListener('visibilitychange', () => schedulePoll(false));

  // ---------------------------------------------------------------- fetch
  const origFetch = window.fetch.bind(window);

  function noteDate(res, url) {
    try {
      if (new URL(url, location.href).origin !== location.origin) return;
      const d = Date.parse(res.headers.get('date') || '');
      if (Number.isFinite(d)) clockOffset = d - Date.now();
    } catch {
      /* ignore */
    }
  }

  async function inspect(url, method, headers, res, completion) {
    noteDate(res, url);
    const ctxId = ctxIdFromUrl(url);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/event-stream')) {
      let aborted = false;
      try {
        await pumpEventStream(res.clone(), ctxId);
      } catch {
        aborted = true;
      }
      if (completion) streamEnd(completion.id, aborted, completion.orgId);
      return;
    }
    if (completion) {
      // Non-streaming completion response (e.g. an error); it is over.
      streamEnd(completion.id, false);
    }
    if (!type.includes('json') || !res.ok) return;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_JSON_BYTES) return;
    const reports = report(await res.clone().json(), ctxId, 'fetch');
    if (method === 'GET' && reports.some((r) => r.running !== null)) {
      rememberPollTarget(url, headers);
      if (reports.some((r) => r.running)) sawRunning();
    }
  }

  window.fetch = async function (input, init) {
    let url = '';
    let method = 'GET';
    let headers = {};
    try {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      url = isReq ? input.url : String(input);
      method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
      headers = headersToObject((init && init.headers) || (isReq ? input.headers : undefined));
    } catch {
      /* fall through with defaults */
    }
    const watch = isInteresting(url);
    let completion = null;
    if (watch && method === 'POST') {
      const m = COMPLETION_RE.exec(url);
      if (m) {
        completion = { orgId: m[1], id: m[2] };
        streamStart(completion.id);
      }
    }
    let res;
    try {
      res = await origFetch(input, init);
    } catch (err) {
      if (completion) streamEnd(completion.id, err && err.name === 'AbortError', completion.orgId);
      throw err;
    }
    if (watch) inspect(url, method, headers, res, completion).catch(() => {});
    return res;
  };

  // ---------------------------------------------------------------- sockets
  const OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    window.WebSocket = class extends OrigWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        const ctxId = ctxIdFromUrl(String(url));
        this.addEventListener('message', (e) => {
          const d = e.data;
          if (typeof d !== 'string' || d.length > 2e6 || (d[0] !== '{' && d[0] !== '[')) return;
          try {
            report(JSON.parse(d), ctxId, 'ws');
          } catch {
            /* ignore */
          }
        });
      }
    };
  }

  const OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    window.EventSource = class extends OrigEventSource {
      constructor(url, config) {
        super(url, config);
        const ctxId = ctxIdFromUrl(String(url));
        this.addEventListener('message', (e) => {
          const d = e.data;
          if (typeof d !== 'string' || (d[0] !== '{' && d[0] !== '[')) return;
          try {
            report(JSON.parse(d), ctxId, 'eventsource');
          } catch {
            /* ignore */
          }
        });
      }
    };
  }
})();
