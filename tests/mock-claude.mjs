// A small stand-in for claude.ai, served through Puppeteer request
// interception at https://claude.ai/* so the extension's content scripts
// inject exactly as they would on the real site.

export const ORG = 'org-0000-mock';

export const CHATS = [
  { uuid: '11111111-1111-4111-8111-111111111111', name: 'Refactor auth middleware' },
  { uuid: '22222222-2222-4222-8222-222222222222', name: 'Explain the flaky CI job' },
  { uuid: '33333333-3333-4333-8333-333333333333', name: 'Draft launch tweet thread' },
];

export const SESSIONS = [
  { id: 'session_01AbCdEfGhJkMnPqRsTuVw01', title: 'feat: websocket reconnect backoff' },
  { id: 'session_01AbCdEfGhJkMnPqRsTuVw02', title: 'fix: date parsing in reports' },
  { id: 'session_01AbCdEfGhJkMnPqRsTuVw03', title: 'chore: bump deps + lint' },
];

const ICON_CHAT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_CODE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>';

export function appHtml() {
  const chatRows = CHATS.map(
    (c) => `<li><div class="group"><a class="row" href="/chat/${c.uuid}">${ICON_CHAT}<span class="t">${c.name}</span></a><button class="menu" aria-label="More options">&#8943;</button></div></li>`,
  ).join('');
  const codeRows = SESSIONS.map(
    (s) => `<li><div class="group"><a class="row" href="/code/${s.id}">${ICON_CODE}<span class="t">${s.title}</span></a><button class="menu" aria-label="More options">&#8943;</button></div></li>`,
  ).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Claude</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; display:flex; height:100vh; background:#262624; color:#c2c0b6; font:14px/1.4 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  nav { width:288px; flex:none; background:#1f1e1d; border-right:1px solid #3a3936; padding:12px 8px; overflow:auto; }
  nav h3 { font-size:12px; color:#8a877e; font-weight:500; margin:16px 10px 6px; }
  nav ul { list-style:none; margin:0; padding:0; }
  .group { position:relative; }
  .row { display:flex; align-items:center; gap:10px; height:34px; padding:0 34px 0 10px; border-radius:8px; color:#c2c0b6; text-decoration:none; white-space:nowrap; overflow:hidden; }
  .row:hover { background-color:#2b2a27; }
  .row[aria-current="page"] { background-color:#141413; color:#faf9f5; }
  .row svg { flex:none; color:#8a877e; }
  .t { overflow:hidden; text-overflow:ellipsis; }
  .menu { position:absolute; right:6px; top:5px; width:24px; height:24px; border:0; background:none; color:#8a877e; border-radius:6px; opacity:0; }
  .group:hover .menu { opacity:1; }
  main { flex:1; padding:32px; }
  button.send { background:#d97757; color:#fff; border:0; border-radius:8px; padding:8px 14px; }
</style></head>
<body>
<nav aria-label="Sidebar">
  <h3>Chats and tasks</h3><ul>${chatRows}</ul>
  <h3>Code</h3><ul>${codeRows}</ul>
</nav>
<main><h1 id="title"></h1><button class="send" id="send">Send</button><div id="out"></div></main>
<script>
  const ORG = ${JSON.stringify(ORG)};
  let inflight = null;
  function route() {
    document.querySelectorAll('nav a').forEach((a) => {
      if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.getElementById('title').textContent = location.pathname;
  }
  function go(path) {
    if (inflight && window.__abortOnLeave) inflight.abort();
    history.pushState({}, '', path);
    route();
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('nav a');
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });
  document.getElementById('send').addEventListener('click', async () => {
    const m = /^\\/chat\\/([0-9a-f-]{36})/.exec(location.pathname);
    if (!m) return;
    inflight = new AbortController();
    try {
      const res = await fetch('/api/organizations/' + ORG + '/chat_conversations/' + m[1] + '/completion', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"hi"}', signal: inflight.signal,
      });
      document.getElementById('out').textContent = (await res.text()).length + ' bytes';
    } catch (err) {
      document.getElementById('out').textContent = String(err);
    }
  });
  route();
  fetch('/v1/sessions', { headers: { 'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': ORG } });
  fetch('/api/organizations/' + ORG + '/chat_conversations?limit=30');
</script>
</body></html>`;
}

// Mutable server-side state the tests drive.
export function createServer() {
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const state = {
    sessionStatus: Object.fromEntries(SESSIONS.map((s) => [s.id, 'idle'])),
    sessionUpdated: Object.fromEntries(SESSIONS.map((s) => [s.id, dayAgo])),
    completionDelayMs: 2000,
    // conversation uuid -> last message sender reported by the detail endpoint
    lastSender: {},
    requests: [],
  };

  const json = (body) => ({
    status: 200,
    contentType: 'application/json',
    headers: { date: new Date().toUTCString() },
    body: JSON.stringify(body),
  });

  async function handle(req) {
    const url = new URL(req.url());
    if (url.hostname !== 'claude.ai') return req.continue();
    const p = url.pathname;
    state.requests.push(`${req.method()} ${p}`);

    if (p === '/v1/sessions') {
      return req.respond(json({
        data: SESSIONS.map((s) => ({
          id: s.id,
          title: s.title,
          session_status: state.sessionStatus[s.id],
          updated_at: state.sessionUpdated[s.id],
        })),
      }));
    }
    if (p === `/api/organizations/${ORG}/chat_conversations`) {
      return req.respond(json(CHATS.map((c) => ({ uuid: c.uuid, name: c.name, updated_at: dayAgo }))));
    }
    const completion = /\/chat_conversations\/([0-9a-f-]{36})\/completion$/.exec(p);
    if (completion && req.method() === 'POST') {
      state.lastSender[completion[1]] = 'human';
      await new Promise((r) => setTimeout(r, state.completionDelayMs));
      state.lastSender[completion[1]] = 'assistant';
      const body = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","role":"assistant"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      try {
        await req.respond({ status: 200, contentType: 'text/event-stream', headers: { date: new Date().toUTCString() }, body });
      } catch {
        /* the page aborted the request */
      }
      return;
    }
    const detail = /\/chat_conversations\/([0-9a-f-]{36})$/.exec(p);
    if (detail) {
      const sender = state.lastSender[detail[1]] || 'assistant';
      return req.respond(json({
        uuid: detail[1],
        updated_at: new Date().toISOString(),
        chat_messages: [
          { uuid: 'm1', sender: 'human', content: [{ type: 'text', text: 'hi' }] },
          ...(sender === 'assistant' ? [{ uuid: 'm2', sender: 'assistant', content: [{ type: 'text', text: 'Hello' }] }] : []),
        ],
      }));
    }
    if (p.startsWith('/api/') || p.startsWith('/v1/')) return req.respond(json({}));
    return req.respond({ status: 200, contentType: 'text/html', body: appHtml() });
  }

  return { state, handle };
}
