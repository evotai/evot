import { backgroundPanel } from './phone-background.js';
import { sessionDrawer } from './phone-directory.js';
import { renderHistory } from './phone-history.js';
import { navigation } from './phone-navigation.js';

import { connectDevice, returnTicket, invitedTerminal } from './phone-device.js';
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('evot.remote'),
  view = null,
  etag = '',
  busy = false;
let timer,
  noticeTimer,
  epoch = 0,
  askId = null,
  catalogKey = '',
  levelsKey = '';
const pickStart = new WeakMap();
// A QR code or account return only starts pairing. Which session to follow is
// always the user's pick from the list, never the window that happened to show the code.
const nav = navigation(null, !!returnTicket, history, sessionStorage);
let terminal = nav.target?.terminal ?? null, newRequest = null, pairing = false, leaving = false, connected = false;
function selectTarget(id, session) {
  nav.select(id, session);
  terminal = nav.target?.terminal ?? null;
}
const background = backgroundPanel(() => {
  etag = '';
  return refresh();
});
const drawer = sessionDrawer({ api, selected: () => connected ? terminal : null, choose, create: () => choose(null, null),
  ask: { available: () => connected && !!view?.input && !busy, submit: (text) => { $('draft').value = text; resize(); $('compose').requestSubmit(); } } });
function requestId() {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
async function choose(id, session, folder) {
  if (!token || busy) return;
  busy = true;
  controls();
  drawer.close();
  const credential = token;
  notice(id ? 'Connecting to live session…' : session ? 'Opening saved session…' : 'Starting a new terminal…', true);
  try {
    if (!id) {
      const request = session || folder ? requestId() : (newRequest ??= requestId());
      const result = await (await api('/open', { requestId: request, session, ...(folder ? { folder } : {}) })).json();
      id = result.terminal;
      if (!session) newRequest = null;
    }
    if (credential !== token) return;
    selectTarget(id, session);
    connected = false;
    ++epoch;
    view = null;
    paired(true);
    etag = '';
    $('history').replaceChildren(); $('outbox').replaceChildren(); outbox.length = 0;
    questions(null);
    $('draft').value = '';
    $('draft').rows = 1;
    await refresh();
    if (token && terminal) notice('');
  } catch (e) {
    notice(e.message, true);
  } finally {
    busy = false;
    controls();
  }
}
const titleCase = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');
function notice(text, persistent = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').hidden = !text;
  if (text && !persistent)
    noticeTimer = setTimeout(() => {
      $('notice').hidden = true;
    }, 3600);
}
function paired(yes) {
  $('openSessions').hidden = $('newSession').hidden = !yes;
  if (!yes) {
    drawer.reset();
    background.render(null);
    $('threadTitle').textContent = 'evot remote';
    $('session').textContent = 'Terminal session';
    $('history').replaceChildren();
    $('questions').replaceChildren();
    askId = null;
    $('draft').value = '';
    $('deviceStatus').textContent = 'Connect to request device access.';
  }
  $('pair-screen').hidden = yes;
  $('pickSession').hidden = !yes || !!terminal;
  $('chat').hidden = $('seat').hidden = !yes || !terminal;
  $('connection').textContent = yes ? terminal ? 'Connecting…' : 'Connected to Mac' : 'Not connected';
  if (yes && terminal && !view) {
    $('session').textContent = 'Live session';
    $('statusDetail').textContent = $('nextModel').textContent = '';
    $('activity').removeAttribute('data-running');
    $('welcome').hidden = true;
    background.render(null);
    $('threadTitle').textContent = 'Opening session…';
    $('status').textContent = 'Waiting for the first live update…';
  }
  if (yes && !terminal) {
    $('threadTitle').textContent = 'Your sessions';
    $('session').textContent = 'Choose a live or saved session';
  }
  controls();
  $('connection').removeAttribute('data-online');
}
function controls() {
  const input = connected ? view?.input : null,
    switchable = connected && !!(input || view?.ask) && !busy;
  drawer.lock(busy);
  $('openSessions').disabled = $('browseSessions').disabled = busy;
  $('send').disabled = busy || !input || !$('draft').value.trim();
  $('send').textContent = busy ? '…' : input === 'steer' ? '↱' : '↑';
  $('send').toggleAttribute('aria-busy', busy);
  $('newSession').disabled = $('drawerNew').disabled = !token || busy;
  $('send').ariaLabel = $('send').title = input === 'steer' ? 'Steer active run' : 'Send message';
  $('draft').placeholder = view?.ask
    ? 'Answer the question above to continue…'
    : input === 'steer'
    ? 'Steer the active run…'
    : 'Ask anything about this project…';
  $('stop').hidden = !view?.canStop;
  $('stop').disabled = busy || !connected;
  $('models').disabled = !switchable || !view.models.options.length;
  $('effort').disabled = !switchable || !!view.models.pending;
  const answer = $('questions').querySelector('[type=submit]');
  if (answer) answer.disabled = busy || !connected || !view?.ask;
}
function models(m) {
  const key = JSON.stringify(m.options),
    select = $('models');
  if (catalogKey !== key) {
    catalogKey = key;
    select.replaceChildren();
    const groups = new Map();
    for (const o of m.options) {
      if (!groups.has(o.group)) {
        const g = document.createElement('optgroup');
        g.label = o.group;
        groups.set(o.group, g);
        select.append(g);
      }
      groups.get(o.group).append(new Option(o.label + (o.warning ? ' · ' + o.warning : ''), o.spec));
    }
  }
  const active = m.options.find((o) => o.spec === m.active);
  select.value = m.active;
  $('modelLabel').textContent = active?.label || m.active || 'Model';
  select.title = active?.spec || m.active;
  const levels = active?.levels ?? [],
    lk = JSON.stringify(levels);
  if (levelsKey !== lk) {
    levelsKey = lk;
    $('effort').replaceChildren(...levels.map((l) => new Option(titleCase(l), l)));
  }
  $('effortPicker').hidden = !levels.length;
  $('effort').value = m.effort;
  $('effortLabel').textContent = titleCase(m.effort) || 'Thinking';
}
function questions(ask) {
  const id = ask?.id ?? null;
  if (id === askId) return;
  askId = id;
  const form = $('questions');
  form.replaceChildren();
  form.hidden = !ask;
  if (!ask) return;
  const label = document.createElement('div');
  label.className = 'eyebrow';
  label.textContent = 'INPUT REQUESTED';
  form.append(label);
  for (const q of ask.questions) {
    const field = document.createElement('fieldset'),
      legend = document.createElement('legend'),
      input = document.createElement('textarea');
    legend.textContent = q.question;
    field.append(legend);
    input.rows = 2;
    input.maxLength = 8192;
    input.required = true;
    input.setAttribute('aria-label', q.question);
    input.placeholder = 'Your answer';
    const choices = document.createElement('div');
    choices.className = 'suggestions';
    for (const o of q.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label + (o.description ? ' · ' + o.description : '');
      b.onclick = () => {
        input.value = o.label;
      };
      choices.append(b);
    }
    field.append(choices, input);
    form.append(field);
  }
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'primary';
  button.textContent = 'Send answers';
  form.append(button);
}
function render(s, mode) {
  if (nav.target?.session && nav.target.session !== s.sessionId)
    throw Object.assign(Error('This window changed sessions. Choose the session again.'), {status:409});
  // A QR points at a window, not at a conversation chosen from Sessions.
  // Never reuse that window's unsent input after a local /new or /resume.
  if (view?.sessionId && view.sessionId !== s.sessionId) {
    $('draft').value = ''; $('draft').rows = 1; questions(null);
  }
  connected = true;
  const chat = $('chat'),
    follow = !view || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 64;
  view = s;
  $('connection').textContent = mode === 'stream' ? 'Live' : 'Connected · polling';
  $('connection').toggleAttribute('data-online', true);
  $('threadTitle').textContent = s.title || (s.sessionId ? `Session ${s.sessionId.slice(-8)}` : 'New conversation');
  $('session').textContent = s.sessionId ? 'Session ' + s.sessionId.slice(-8) : 'New session';
  const pending = s.models.pending,
    next = pending && s.models.options.find((o) => o.spec === pending.spec);
  if ($('status').textContent !== s.status) $('status').textContent = s.status;
  $('statusDetail').textContent = s.statusDetail ?? '';
  $('nextModel').textContent = pending
    ? `Next request → ${next?.label || pending.spec}${pending.effort ? ' · ' + pending.effort : ''}`
    : '';
  $('activity').toggleAttribute('data-running', s.active);
  models(s.models);
  place(s.place);
  background.render(s.background);
  settleOutbox(s);
  $('welcome').hidden = !!renderHistory($('history'), s) || !!s.ask || s.active || outbox.length > 0;
  questions(s.ask);
  controls();
  if (follow) chat.scrollTop = chat.scrollHeight;
  jumpState();
}
// Where this window runs: folder, machine, branch. The folder chip opens the
// folder sheet; a window never changes folder, a new session starts there instead.
function place(p) {
  $('place').hidden = !p;
  if (!p) return;
  $('placeName').textContent = p.name;
  $('placeFolder').title = `${p.path} · start a session in another folder`;
  $('placeHost').textContent = p.host;
  $('placeBranchChip').hidden = !p.branch;
  $('placeBranch').textContent = p.branch ?? '';
}
const folderPanel = $('folderPanel');
let openingFolder = null;
async function showFolders() {
  if (!token || busy) return;
  $('folderList').replaceChildren(); $('folderMessage').textContent = 'Loading folders…';
  if (!folderPanel.open) folderPanel.showModal();
  try {
    const { folders } = await (await api('/folders')).json();
    if (!folderPanel.open) return;
    $('folderMessage').textContent = folders.length ? '' : 'No folders yet.';
    $('folderList').replaceChildren(...folders.map((f) => {
      const b = document.createElement('button'); b.type = 'button';
      if (f.path === view?.place?.path) b.setAttribute('aria-current', 'true');
      const name = document.createElement('strong'), meta = document.createElement('small');
      name.textContent = f.name;
      meta.textContent = [f.path, f.open ? `${f.open} open` : '', f.sessions ? `${f.sessions} saved` : ''].filter(Boolean).join(' · ');
      b.append(name, meta);
      b.onclick = () => startIn(f, b);
      return b;
    }));
  } catch (e) { $('folderMessage').textContent = e.message || 'Could not load folders.'; }
}
async function startIn(folder, button) {
  if (openingFolder || busy) return;
  openingFolder = folder.id; button.disabled = true;
  const label = button.firstChild.textContent; button.firstChild.textContent = `Starting in ${label}…`;
  try { await choose(null, null, folder.id); folderPanel.close(); }
  finally { openingFolder = null; button.disabled = false; button.firstChild.textContent = label; }
}
$('placeFolder').onclick = showFolders;
$('closeFolders').onclick = () => folderPanel.close();
folderPanel.onclick = (e) => { if (e.target === folderPanel) folderPanel.close(); };
// A browser the Mac already approved reconnects by itself: after the gateway
// restarts, the tab was suspended, or the network came back. Only an explicit
// denial or a storage failure hands control back to the button.
let reconnectTimer, reconnectFailures = 0;
const approvedBefore = () => { try { return localStorage.getItem('evot.remote.approved') === '1'; } catch { return false; } };
const rememberApproval = (yes) => { try { yes ? localStorage.setItem('evot.remote.approved', '1') : localStorage.removeItem('evot.remote.approved'); } catch { /* Without site data, every visit pairs manually. */ } };
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (token || !approvedBefore() || document.hidden) return;
  reconnectTimer = setTimeout(() => { if (!token && !document.hidden) void pair(true); }, Math.min(15000, 1000 * 2 ** Math.min(reconnectFailures, 4)));
}
function unpair() {
  ++epoch; liveRequest?.abort(); clearTimeout(timer);
  connected = false;
  token = null;
  sessionStorage.removeItem('evot.remote');
  view = null; etag = '';
  paired(false);
  $('deviceStatus').textContent = 'Your connection expired or access was revoked. Reconnect to check this browser’s approval.';
  $('pair').querySelector('button').textContent = 'Reconnect to Mac';
  reconnectFailures++;
  scheduleReconnect();
}
async function api(path, body, extra = {}, signal) {
  const credential = token;
  const headers = { ...extra };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (terminal && (path === '/state' || path === '/action' || path.startsWith('/sessions?limit='))) headers['X-Evot-Terminal'] = terminal;
  if (path === '/state' && background.selected) headers['X-Evot-Background'] = background.selected;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: signal ?? AbortSignal.timeout(path.startsWith('/sessions?limit=') ? 30000 : path === '/open' ? 15000 : 8000),
  });
  if (res.status === 401 && token === credential) unpair();
  if (!res.ok && res.status !== 304) throw Object.assign(Error(await res.text()), {status:res.status});
  return res;
}
let liveRequest, pollUntil = 0, nextOwnerCheck = 0, checkingOwner = false, failures = 0;
const inventory = async () => (await api('/sessions?online')).json();
function followOwner(owner, session) {
  selectTarget(owner.terminal, session);
  view = null; connected = false; etag = '';
  $('connection').textContent = 'Following live window…';
  $('connection').removeAttribute('data-online');
  controls();
}
// A saved conversation can later become active in a shared Mac TUI. Follow
// only the same session. Never migrate a running action or create a terminal.
async function checkIdleOwner(mine) {
  const session = nav.target?.session;
  if (!connected || !session || view?.active || busy || checkingOwner || Date.now() < nextOwnerCheck) return;
  checkingOwner = true; nextOwnerCheck = Date.now() + 5000;
  try {
    const owner = (await inventory()).online.find(row => row.session === session);
    if (mine === epoch && token && !busy && !view?.active && nav.target?.session === session && owner && !owner.phoneCreated && owner.terminal !== terminal) {
      followOwner(owner, session);
      void refresh();
    }
  } catch { /* An inventory failure must not interrupt the current live stream. */ }
  finally { checkingOwner = false; }
}
// Callers that change selection/submit wait only for the first frame, not EOF.
function refresh() {
  return new Promise(ready => { void synchronize(ready); });
}
async function synchronize(ready) {
  clearTimeout(timer);
  const mine = ++epoch;
  liveRequest?.abort();
  if (!token || !terminal || document.hidden) { ready(); return; }
  const ctrl = liveRequest = new AbortController(), live = Date.now() >= pollUntil;
  let watchdog;
  const heartbeat = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), 10000); };
  try {
    heartbeat();
    const res = await api('/state', null, live ? { Accept: 'text/event-stream' } : etag ? { 'If-None-Match': etag } : {}, ctrl.signal);
    if (mine !== epoch || !token) return;
    if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buffer = '', initialized = false;
      while (mine === epoch && token) {
        const chunk = await reader.read();
        if (mine !== epoch || !token) return;
        if (chunk.done) throw Error('Connection closed.');
        heartbeat();
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!event.startsWith('data: ')) { void checkIdleOwner(mine); continue; }
          const frame = JSON.parse(event.slice(6));
          if (frame.status === 401) unpair();
          if (frame.status) throw Object.assign(Error('Live session unavailable.'), {status:frame.status});
          if (!frame.view && !initialized) throw Error('Missing first snapshot.');
          render(frame.view ?? { ...view, ...frame.patch }, 'stream');
          initialized = true; etag = ''; failures = 0; ready();
          void checkIdleOwner(mine);
        }
      }
      return;
    }
    const snapshot = res.status === 304 ? null : await res.json();
    if (mine !== epoch) return;
    if (snapshot) {
      etag = res.headers.get('etag');
      render(snapshot, 'poll');
    }
    failures = 0;
    void checkIdleOwner(mine);
  } catch (e) {
    if (mine !== epoch) return;
    failures++; connected = false; etag = ''; controls();
    if (e.status === 409 || e.status === 403) {
      // Never silently resume a copy or send a draft to a different session.
      // If the conversation moved to another shared TUI, follow that same session only.
      const session = nav.target?.session;
      let rows;
      try { rows = await inventory(); } catch { /* inconclusive; retry the selected window */ }
      if (mine !== epoch || !token) return;
      const owner = session && rows?.online.find(row => row.session === session);
      if (owner && owner.terminal !== terminal) {
        followOwner(owner, session);
        return;
      }
      if (rows && !rows.unavailable && !owner && (session || !rows.online.some(row => row.terminal === terminal))) {
        selectTarget(null, null); view = null; paired(true); notice('');
        drawer.open('This window is no longer sharing that session. Choose a live session.');
        return;
      }
    }
    if (live) pollUntil = Date.now() + 10000;
    $('connection').removeAttribute('data-online');
    $('connection').textContent = 'Reconnecting…';
    $('activity').removeAttribute('data-running');
    $('statusDetail').textContent = $('nextModel').textContent = '';
    $('status').textContent = token
      ? 'Waiting for the Mac. Reconnecting automatically…'
      : 'Pair again on the Mac.';
    if (!token) notice(e.message, true);
  } finally {
    clearTimeout(watchdog);
    ctrl.abort(); ready();
    if (mine === epoch && token && terminal && !document.hidden)
      timer = setTimeout(refresh, failures ? Math.min(5000, 300 * 2 ** Math.min(failures - 1, 5)) : view?.active && !view.ask ? 300 : 800);
  }
}
async function pair(auto = false) {
  if (pairing || leaving) return;
  pairing = true;
  clearTimeout(reconnectTimer);
  const form = $('pair'), button = form.querySelector('button');
  let countdown;
  button.disabled = true; form.setAttribute('aria-busy', 'true');
  $('approvalCode').hidden = $('approvalClock').hidden = true;
  button.textContent = auto ? 'Reconnecting…' : 'Connecting…';
  $('deviceStatus').textContent = auto ? 'Reconnecting to your Mac…' : 'Contacting your Mac…';
  notice('');
  try {
    const result = await connectDevice(async (path,data) => (await api(path,data)).json(), (step, code, until) => {
      if (step === 'signin') {
        button.textContent = 'Opening sign-in…';
        $('deviceStatus').textContent = 'Continue with your evot account. You’ll return here automatically.';
      } else if (step === 'verify') {
        button.textContent = 'Verifying browser…';
        $('deviceStatus').textContent = 'Checking whether the Mac already knows this browser…';
      } else {
        button.textContent = 'Waiting for approval…';
        $('deviceStatus').textContent = `In the Mac TUI that received the request, check the code, then run /remote approve ${code}.`;
        $('approvalCode').hidden = $('approvalClock').hidden = false;
        $('approvalCode').textContent = code;
        const tick = () => { $('approvalClock').textContent = `Expires in ${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s · this page updates automatically`; };
        tick(); countdown = setInterval(tick, 1000);
      }
    }, url => { nav.redirect(); location.assign(url); leaving = true; });
    if (!result) return;
    sessionStorage.setItem('evot.remote', result.token);
    token = result.token;
    rememberApproval(true); reconnectFailures = 0;
    etag = '';
    $('deviceStatus').textContent = 'This device is approved.';
    notice('');
    paired(true);
    if (terminal) await refresh(); else drawer.open();
  } catch (e) {
    const storage = e.name === 'SecurityError' || e.name === 'QuotaExceededError';
    const unreachable = e.name === 'TimeoutError' || e instanceof TypeError || e.status >= 500;
    if (!storage && !unreachable) rememberApproval(false); // denied, expired or revoked: wait for the user
    $('deviceStatus').textContent = storage
      ? 'Browser storage is blocked. Open the invite in Safari or Chrome with site data enabled.'
      : unreachable
        ? approvedBefore() ? 'Could not reach the Mac. Retrying automatically; check that /remote is still running.'
          : 'Could not reach the Mac. Check that /remote is still running and try again.'
        : e.message || 'Could not connect. Try again.';
    button.textContent = unreachable && approvedBefore() ? 'Retry now' : 'Try again';
    if (unreachable) { reconnectFailures++; scheduleReconnect(); }
  } finally {
    clearInterval(countdown);
    $('approvalCode').hidden = $('approvalClock').hidden = true;
    pairing = false;
    if (!leaving) { button.disabled = false; form.removeAttribute('aria-busy'); }
  }
}
async function action(payload, done, failed) {
  if (!connected || !view || busy) return;
  busy = true;
  controls();
  const feedback = {
    send: ['Sending message…', 'Message sent.'], steer: ['Sending guidance…', 'Guidance sent.'],
    answer: ['Sending answers…', 'Answers sent.'], stop: ['Stopping this run…', 'Stop requested.'],
    'select-model': ['Applying selection…', 'Selection received.'], 'tool-view': ['Updating details…', 'Details updated.'],
  }[payload.kind];
  notice(feedback[0], true);
  try {
    await api('/action', { generation: view.generation, ...payload });
    done?.();
    notice(feedback[1]);
  } catch (e) {
    failed?.();
    notice(e.message + ' Check before retrying.', true);
  } finally {
    etag = '';
    await refresh();
    busy = false;
    controls();
  }
}
for (const el of [$('models'), $('effort')]) {
  const capture = () => {
    if (view)
      pickStart.set(el, { generation: view.generation, revision: view.models.revision, spec: view.models.active });
  };
  el.onpointerdown = capture;
  el.onfocus = capture;
  el.onchange = () => {
    if (!view) return;
    const intent = pickStart.get(el) ?? {
      generation: view.generation,
      revision: view.models.revision,
      spec: view.models.active,
    };
    pickStart.delete(el);
    void action({
      kind: 'select-model',
      ...intent,
      ...(el === $('models') ? { spec: el.value } : { effort: el.value }),
    });
  };
}
$('pair').onsubmit = (e) => {
  e.preventDefault();
  void pair();
};
// The sent text shows at once as a pending bubble; the Mac's own copy replaces
// it when the next frame carries that user turn. A failure puts the draft back.
const outbox = [];
function settleOutbox(s) {
  const spoken = new Set(s.messages.filter((m) => m.role === 'user').map((m) => m.text));
  for (const item of outbox.splice(0)) {
    if (spoken.has(item.text) || Date.now() > item.expires) item.el.remove();
    else outbox.push(item);
  }
}
$('compose').onsubmit = (e) => {
  e.preventDefault();
  const text = $('draft').value, kind = view?.input;
  if (!kind || !text.trim() || busy) return;
  const el = document.createElement('article');
  el.className = 'message message-user pending';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text.trim();
  const state = document.createElement('small'); state.className = 'outbox-state'; state.textContent = kind === 'steer' ? 'Steering…' : 'Sending…';
  el.append(bubble, state);
  $('outbox').append(el);
  outbox.push({ text: text.trim(), el, expires: Date.now() + 30000 });
  $('draft').value = ''; resize(); $('welcome').hidden = true;
  $('chat').scrollTop = $('chat').scrollHeight;
  void action({ kind, text }, () => { state.textContent = kind === 'steer' ? 'Steered' : 'Sent'; }, () => {
    el.remove(); outbox.splice(outbox.findIndex((i) => i.el === el), 1);
    if (!$('draft').value) { $('draft').value = text; resize(); }
  });
};
$('questions').onsubmit = (e) => {
  e.preventDefault();
  if (view?.ask)
    void action({
      kind: 'answer',
      id: askId,
      answers: [...$('questions').querySelectorAll('textarea')].map((i) => i.value),
    });
};
$('stop').onclick = () => {
  if (view?.canStop) void action({ kind: 'stop' });
};
function resize() {
  const d = $('draft');
  d.rows = Math.min(5, Math.max(1, d.value.split('\n').length));
  controls();
}
function jumpState() {
  const c = $('chat');
  $('jump').hidden = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  $('jump').textContent = view?.ask ? '↓ Answer question' : '↓ Latest';
}
$('chat').onscroll = jumpState;
$('jump').onclick = () => {
  $('chat').scrollTop = $('chat').scrollHeight;
};
$('draft').oninput = resize;
$('draft').onkeydown = (e) => {
  if (
    e.key === 'Enter' &&
    !e.shiftKey &&
    !e.isComposing &&
    (matchMedia('(pointer: fine)').matches || e.metaKey || e.ctrlKey)
  ) {
    e.preventDefault();
    $('compose').requestSubmit();
  }
};
$('welcome').onclick = (e) => {
  const prompt = e.target.closest('[data-prompt]')?.dataset.prompt;
  if (prompt) {
    $('draft').value = prompt;
    resize();
    $('draft').focus();
  }
};
$('history').onclick = async (e) => {
  if (e.target.closest('.tool-details')) {
    if (view) void action({ kind: 'tool-view', expanded: !view.expanded });
    return;
  }
  const button = e.target.closest('[data-copy-code]');
  if (!button) return;
  const code = button.closest('.code-block').querySelector('code');
  try {
    await navigator.clipboard.writeText(code.textContent);
    notice('Code copied.');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    notice('Code selected · use Copy.');
  }
};
document.addEventListener('visibilitychange', () => { refresh(); scheduleReconnect(); });
window.addEventListener('online', () => { refresh(); scheduleReconnect(); });
$('browseSessions').onclick = drawer.open;
window.addEventListener('pageshow', event => {
  if (event.persisted && leaving) {
    leaving = false; $('pair').removeAttribute('aria-busy');
    const button = $('pair').querySelector('button'); button.disabled = false; button.textContent = 'Continue sign-in';
    $('deviceStatus').textContent = 'Sign-in wasn’t finished.';
  }
});
paired(!!token);
const connectButton = $('pair').querySelector('button');
connectButton.textContent = 'Connect to Mac';
connectButton.disabled = false;
if (!token && (returnTicket || invitedTerminal || approvedBefore())) void pair(!returnTicket && !invitedTerminal);
else if (token && !terminal) drawer.open();
else void refresh();
