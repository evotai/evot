import { paintChangesButton, reviewNavigation } from './phone-review.js';
import { questionPanel } from './phone-ask.js';
import { inlineCommandGhost, installTouchDraft } from './phone-draft.js';
import { backgroundPanel } from './phone-background.js';
import { runInterrupt } from './phone-interrupt.js';
import { turnStartFeedback } from './phone-turn-start.js';
import { registerActivityMarks } from './phone-activity.js';
import { completionReminder } from './phone-reminder.js';
import { applyEdit, enterIntent } from './phone-editor.js';
import { composerTab, draftHintText, inlineSuggestion } from './phone-composer-keys.js';
import { photoViewer, messagePhotos } from './phone-photo-preview.js';
import { taskKeys } from './phone-task-keys.js';
import { lastDraft, pendingDrafts, queueStrip } from './phone-queue.js';
import { sessionDrawer } from './phone-directory.js';
import { renderHistory, updateToolAt } from './phone-history.js';
import { conversationScroll } from './phone-scroll.js';
import { fitConversationViewport } from './phone-viewport.js';
import { navigation } from './phone-navigation.js';
import { imageTray } from './phone-images.js';
import { CONFIRM_MS, delivered, photoExpired, refused, requestTimeout, uploadRequest } from './phone-send.js';
import { commandMenu, phoneLocalCommand, phoneShortcut } from './phone-commands.js';
import { draftCarry } from './phone-update.js';

import { connectDevice, returnTicket, invitedTerminal } from './phone-device.js';
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('evot.remote'),
  view = null,
  etag = '',
  busy = false, sendingMessage = false;
let timer,
  noticeTimer,
  epoch = 0,
  catalogKey = '',
  levelsKey = '';
registerActivityMarks(document, document.documentElement.dataset.activityFrames.split(' '));
const messageField = installTouchDraft($('draft'), max => notice(`Message limit: ${max} characters.`));
const renderCommandGhost = inlineCommandGhost(messageField, $('draftGhost'));
fitConversationViewport($('conversation'));
const compactComposer = $('compactComposer');
const transcript = conversationScroll({chat:$('chat'), seat:$('seat'), editor:$('composerContent'),
  dock:compactComposer, write:$('writeMessage'), jump:$('jump'), draft:messageField, compactChanged:value => { shortcuts.setCompact(value); tab.setCompact(value); }});
const askPanel = questionPanel($('questions'), action);
const reminder = completionReminder($('completionSound'), () => inventory(), notice);
const pickStart = new WeakMap();
// A QR code or account return only starts pairing. Which session to follow is
// always the user's pick from the list, never the window that happened to show the code.
const nav = navigation(null, !!returnTicket, history, sessionStorage);
let terminal = nav.target?.terminal ?? null, newRequest = null, pairing = false, leaving = false, connected = false;
let linkStatus = null;
const starting = turnStartFeedback(paintRunStatus);
const stopping = runInterrupt({
  lock(locked) { busy = locked || sendingMessage; paintRunStatus(); controls(); },
  async post(message) {
    const res = await api('/action',message,{Accept:'application/json'});
    return res.status === 204 ? null : res.json();
  },
  replace(state) {
    // An SSE patch from before the stop cannot be merged onto the POST snapshot.
    ++epoch; liveRequest?.abort(); etag = '';
    render(state); void refresh();
  }, refresh, error:e => notice(e.message + ' Check the current run before retrying.',true),
});
const syncReview = reviewNavigation($('changesPage'), $('openChanges'), () => $('pair-screen').hidden ? terminal : null);
// Only an explicit sign-in navigates away; keep its draft for the return trip.
const drafts = draftCarry(sessionStorage);
let draftCarried = true;
const keepDraft = () => drafts.keep(terminal, $('draft').value);
// Only dismissal is phone-local. Candidates and feedback always come from the selected TUI.
let dismissed = '';
function selectTarget(id, session) {
  stopping.clear(); starting.clear();
  nav.select(id, session);
  reminder.select(nav.target);
  terminal = nav.target?.terminal ?? null;
}
const background = backgroundPanel(document, () => {
  etag = '';
  return refresh();
});
function clearDraft() { $('draft').value = ''; photos.clear(); resize(); }
function draftEmpty() { return !messageField.value && !tab.composing; }
function currentSuggestion(empty = draftEmpty()) {
  return inlineSuggestion(connected ? view : null, empty && !photos.count, dismissed);
}
function dismissHint() {
  if (commands.dismiss()) return;
  const preview = currentSuggestion();
  if (preview) { dismissed = preview.key; controls(); }
}
const shortcuts = taskKeys($('escapeKey'), {pull:pullDraft, dismissMenu:dismissHint, clear:clearDraft, interruptAsk:askPanel.interrupt, act:action});
const commands = commandMenu($('draft'), $('commandMenu'), resize);
const tab = composerTab($('draft'),$('tabKey'), {commands, changed:resize, queue:() => submitMessage('queue'),
  suggest:() => action({kind:'suggest'}), disarm:shortcuts.disarm});
const viewer = photoViewer($('photoPreview')), sentPhotos = messagePhotos();
const outbox = [], renderQueue = queueStrip($('promptQueue'),viewer.thumbnail);
const photos = imageTray({ thumbnail:viewer.thumbnail, tray: $('attachments'), input: $('imageInput'), button: $('attach'),
  changed: () => controls(), notice: (text) => notice(text),
  upload: async (blob,progress,signal) => token ? (await (await api('/photos',blob,{},signal,progress)).json()).id : null });
const drawer = sessionDrawer({ api, selected: () => connected ? terminal : null, choose, create: () => choose(null, null),
  createIn: () => showFolders(), host: () => view?.place?.host,
  ask: { available: () => connected && view?.input === 'send' && !busy, submit: (text) => { $('draft').value = text; resize(); submitMessage(view?.input); } } });
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
  notice(id ? '' : session ? 'Opening session…' : 'Starting terminal…', true);
  try {
    if (!id) {
      const request = session || folder ? requestId() : (newRequest ??= requestId());
      const result = await (await api('/open', { requestId: request, session, ...(folder ? { folder } : {}) })).json();
      id = result.terminal;
      if (!session) newRequest = null;
    }
    if (credential !== token) return;
    selectTarget(id, session);
    notice('');
    connected = false;
    ++epoch;
    view = null;
    paired(true);
    etag = '';
    $('history').replaceChildren(); clearOutbox(); photos.clear();
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
  $('sessionUnavailable').hidden = true;
  $('openSessions').hidden = $('newSession').hidden = !yes;
  reminder.select(nav.target);
  reminder.setPaired(yes && !!token);
  if (!yes) {
    drawer.reset();
    clearOutbox(); photos.clear();
    background.render(null);
    $('threadTitle').textContent = 'evot remote';
    $('history').replaceChildren();
    $('draft').value = '';
    $('deviceStatus').textContent = '';
  }
  $('pair-screen').hidden = yes;
  $('openChanges').hidden = !yes || !terminal;
  syncReview();
  $('pickSession').hidden = !yes || !!terminal;
  $('chat').hidden = !yes || !terminal;
  setLinkStatus(yes && terminal ? 'Connecting…' : '', true);
  if (yes && terminal && !view) {
    $('statusDetail').textContent = $('nextModel').textContent = '';
    $('welcome').hidden = true;
    background.render(null);
    $('threadTitle').textContent = 'Session';
    $('chatLoading').hidden = false;
  }
  if (yes && !terminal) {
    $('threadTitle').textContent = 'Your sessions';
  }
  transcript.latest();
  controls();
}
function controls() {
  const input = connected ? view?.input : null,
    switchable = connected && !!(input || view?.ask) && !busy;
  commands.render(input && !busy && !tab.composing ? view : null);
  paintChangesButton($('openChanges'), connected && !!token, view);
  drawer.lock(busy || !token);
  $('resumeLinked').disabled = busy || !token;
  $('openSessions').disabled = $('browseSessions').disabled = busy || !token;
  const empty = draftEmpty(), preview = currentSuggestion(empty), candidate = preview?.candidate || '';
  $('send').disabled = busy || !input || (!$('draft').value.trim() && !photos.count && !candidate);
  $('attach').disabled = busy || !input || photos.count >= 4;
  const queuedCount = renderQueue(view, outbox), queueSummary = $('queueSummary');
  const paused = view?.promptQueue?.filter(r => r.state === 'paused').length ?? 0;
  const queueLabel = [queuedCount > paused && `${queuedCount - paused} queued`, paused && `${paused} paused`].filter(Boolean).join(' · ');
  if (queueSummary.textContent !== queueLabel) queueSummary.textContent = queueLabel;
  queueSummary.hidden = !queuedCount;
  $('send').textContent = busy ? '…' : input === 'steer' ? '↱' : '↑';
  $('send').toggleAttribute('aria-busy', busy);
  $('newSession').disabled = $('drawerNew').disabled = !token || busy;
  $('send').ariaLabel = $('send').title = candidate ? 'Send suggestion' : input === 'steer' ? 'Steer active run' : 'Send message';
  const hint = $('draftHint'), text = draftHintText(empty, connected ? view : null, preview, queuedCount - paused);
  if (hint.textContent !== text) hint.textContent = text;
  hint.hidden = !text;
  hint.toggleAttribute('data-preview', !!preview);
  const commandHint = renderCommandGhost(commands.hint);
  const pending = lastDraft(view);
  const hintKind = !$('commandMenu').hidden ? 'menu' : commandHint || preview?.candidate ? 'inline' : null;
  shortcuts.render(connected && !tab.composing ? view : null, busy, $('draft').value || photos.count,
    pending && outbox.some(item => item.draftId === pending) ? pending : null,
    input && hintKind, sendingMessage && !stopping.pending);
  tab.render(connected ? view : null, busy, photos.count, candidate);
  background.setConnected(connected);
  $('models').disabled = !switchable || !view.models.options.length;
  $('effort').disabled = !switchable || !!view.models.pending;
  $('compose').hidden = !!view?.ask;
  askPanel.render(view?.ask, view?.generation, busy || !connected);
  transcript.update(!!view && !view.ask, !empty || !!photos.count);
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
function setLinkStatus(label, spinning = false) {
  linkStatus = label ? {label, spinning} : null;
  $('seat').hidden = !$('pair-screen').hidden || (!view && !linkStatus);
  $('composerStack').hidden = !view;
  paintRunStatus();
}
function paintRunStatus() {
  const pending = stopping.pending ? 'Stopping…' : starting.label;
  const label = linkStatus?.label ?? pending ?? view?.status ?? '';
  if ($('status').textContent !== label) $('status').textContent = label;
  $('statusDetail').textContent = linkStatus || pending ? '' : view?.statusDetail ?? '';
  $('activity').toggleAttribute('data-running', linkStatus?.spinning ?? (!!pending || (!!view?.active && !view.ask)));
  const line = document.querySelector('.run-line');
  line.toggleAttribute('data-connection', !!linkStatus);
  line.toggleAttribute('data-active', !!linkStatus || !!pending || !!view?.active);
}
function render(s) {
  if (nav.target?.session && nav.target.session !== s.sessionId)
    throw Object.assign(Error('This window changed sessions. Choose the session again.'), {status:409});
  // Bind a newly opened window to its conversation as soon as the host assigns
  // an ID. A reload or copied URL must never silently follow a different chat.
  if (terminal && !nav.target?.session && s.sessionId) {
    nav.select(terminal, s.sessionId); reminder.select(nav.target);
  }
  // Never reuse a window's unsent input across conversations.
  if (view?.sessionId && view.sessionId !== s.sessionId) {
    $('draft').value = ''; $('draft').rows = 1; clearOutbox(); photos.clear(); askPanel.render(null, null, true);
    background.render(null);
    transcript.latest();
  }
  missingTarget = null;
  $('sessionUnavailable').hidden = true;
  connected = true;
  $('chatLoading').hidden = true;
  if (draftCarried) {
    draftCarried = false;
    const kept = $('draft').value ? '' : drafts.take(terminal);
    if (kept) { $('draft').value = kept; resize(); }
  }
  if ((s.suggestion || s.suggestionHint) !== (view?.suggestion || view?.suggestionHint)) dismissed = '';
  view = s;
  stopping.observe(s);
  $('resumeConnection').hidden = true;
  $('threadTitle').textContent = s.title || (s.sessionId ? `Session ${s.sessionId.slice(-8)}` : 'New conversation');
  const pending = s.models.pending,
    next = pending && s.models.options.find((o) => o.spec === pending.spec);
  starting.observe(s);
  setLinkStatus('');
  $('nextModel').textContent = pending
    ? `next: ${next?.label || pending.spec}${pending.effort ? ' · ' + pending.effort : ''}`
    : '';
  models(s.models);
  place(s.place);
  background.render(s.background);
  settleOutbox(s);
  transcript.paintHistory(() => {
    $('welcome').hidden = !!renderHistory($('history'), s, sentPhotos, viewer.thumbnail) || !!s.ask || s.active || outbox.length > 0;
  });
  controls();
  transcript.keepLatest();
}
// Where this window runs, in the status line: folder and branch. The computer's
// name sits at the foot of the Sessions drawer; a new folder starts from its + button.
function place(p) {
  $('place').hidden = !p;
  if (!p) return;
  $('placeName').textContent = p.name;
  $('place').title = p.path;
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
$('closeFolders').onclick = () => folderPanel.close();
folderPanel.onclick = (e) => { if (e.target === folderPanel) folderPanel.close(); };
// A browser the computer already approved reconnects by itself: after the gateway
// restarts, the tab was suspended, or the network came back. Only an explicit
// denial or a storage failure hands control back to the button.
let reconnectTimer, reconnectFailures = 0, needsInteraction = false;
const approvedBefore = () => { try { return localStorage.getItem('evot.remote.approved') === '1'; } catch { return false; } };
const rememberApproval = () => { try { localStorage.setItem('evot.remote.approved', '1'); } catch { /* Without site data, every visit pairs manually. */ } };
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (token || needsInteraction || (!approvedBefore() && !$('pair-screen').hidden) || document.hidden) return;
  reconnectTimer = setTimeout(() => { if (!token && !document.hidden) void pair(true); }, Math.min(15000, 1000 * 2 ** Math.min(reconnectFailures, 4)));
}
function reconnecting() {
  starting.clear();
  connected = false;
  setLinkStatus('Reconnecting…', true);
  controls();
}
function unpair() {
  ++epoch; liveRequest?.abort(); clearTimeout(timer);
  token = null;
  reminder.setPaired(false);
  stopping.clear();
  sessionStorage.removeItem('evot.remote');
  etag = '';
  reconnecting();
  $('deviceStatus').textContent = 'Access ended.';
  $('pair').querySelector('button').textContent = 'Reconnect';
  reconnectFailures++;
  scheduleReconnect();
}
// iPadOS in desktop mode describes itself as a Mac in its user agent.
const touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
async function api(path, body, extra = {}, signal, progress) {
  const credential = token;
  const headers = { ...extra };
  if (token) {
    headers.Authorization = 'Bearer ' + token;
    if (touchMac) headers['X-Evot-Touch-Mac'] = '1';
  }
  if (terminal && (path === '/state' || path === '/action' || path.startsWith('/sessions?limit='))) headers['X-Evot-Terminal'] = terminal;
  if (path === '/state' && background.selected) headers['X-Evot-Background'] = background.selected;
  const binary = body instanceof Blob;
  if (body) headers['Content-Type'] = binary ? body.type : 'application/json';
  const payload = binary ? body : body ? JSON.stringify(body) : undefined;
  const timeout = requestTimeout(path, binary ? body.size : payload?.length);
  const res = progress ? await uploadRequest(path,payload,headers,timeout,progress,signal) : await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: payload,
    cache: 'no-store',
    signal: signal ?? AbortSignal.timeout(timeout),
  });
  if (res.status === 401 && credential && token === credential) unpair();
  if (!res.ok && res.status !== 304) throw Object.assign(Error(await res.text()), {status:res.status});
  return res;
}
let missingTarget = null;
let liveRequest, pollUntil = 0, nextOwnerCheck = 0, checkingOwner = false, failures = 0;
const inventory = async () => (await api('/sessions?online')).json();
function followOwner(owner, session) {
  selectTarget(owner.terminal, session);
  view = null; connected = false; etag = '';
  background.render(null);
  setLinkStatus('Following live window…', true);
  controls();
}
// A saved conversation can later become active in a shared TUI. Follow
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
          render(frame.view ?? { ...view, ...frame.patch });
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
      render(snapshot);
    }
    failures = 0;
    void checkIdleOwner(mine);
  } catch (e) {
    if (mine !== epoch) return;
    failures++; etag = ''; reconnecting();
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
        // A restarting window can briefly disappear from the directory.
        if (missingTarget?.id !== terminal) missingTarget = {id:terminal, since:Date.now()};
        if (e.status === 403 || Date.now() - missingTarget.since >= 8000) {
          if (session) {
            // Keep the bookmark (and any draft). Opening a saved session can
            // launch a terminal; do that only on an explicit resume.
            setLinkStatus('Session unavailable');
            $('chatLoading').hidden = $('welcome').hidden = true; $('sessionUnavailable').hidden = false;
            return;
          }
          missingTarget = null;
          selectTarget(null, null); view = null; paired(true); notice('');
          drawer.open('That window has closed or stopped sharing. Tap the session to resume it.');
          return;
        }
      }
    }
    if (live) pollUntil = Date.now() + 10000;
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
  const inPlace = $('pair-screen').hidden;
  const showStatus = (label, spinning = false) => {
    if (inPlace) setLinkStatus(label, spinning); else $('deviceStatus').textContent = label;
  };
  needsInteraction = false;
  $('resumeConnection').hidden = true;
  let countdown;
  button.disabled = true;
  $('approvalCode').hidden = $('approvalClock').hidden = true;
  showStatus(auto ? 'Reconnecting…' : 'Connecting…', true);
  notice('');
  try {
    const result = await connectDevice(async (path,data) => (await api(path,data)).json(), (step, code, until) => {
      if (step === 'signin') {
        showStatus('Opening sign-in…', true);
      } else if (step === 'approval') {
        if (inPlace) { showStatus(`In evot: /remote approve ${code}`); return; }
        showStatus(invitedTerminal ? 'Match the code in the QR terminal:' : 'Match the code in your evot terminal:');
        $('approvalCode').hidden = $('approvalClock').hidden = false;
        $('approvalCode').textContent = `/remote approve ${code}`;
        const tick = () => { $('approvalClock').textContent = `Expires in ${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s`; };
        tick(); countdown = setInterval(tick, 1000);
      }
    }, url => { keepDraft(); nav.redirect(); location.assign(url); leaving = true; }, auto);
    if (!result) return;
    sessionStorage.setItem('evot.remote', result.token);
    token = result.token;
    rememberApproval(); reconnectFailures = 0;
    etag = '';
    notice('');
    // Silent renewal is not navigation: paired() would reset the reader's scroll.
    if (!$('pair-screen').hidden) paired(true);
    else reminder.setPaired(true);
    controls();
    if (terminal) await refresh();
    else if (!inPlace) drawer.open();
    else setLinkStatus('');
  } catch (e) {
    const storage = e.name === 'SecurityError' || e.name === 'QuotaExceededError';
    const unreachable = e.name === 'TimeoutError' || e instanceof TypeError || e.status === 429 || e.status >= 500;
    needsInteraction = !unreachable;
    showStatus(storage
      ? 'Enable browser storage to connect.'
      : unreachable
        ? inPlace ? 'Reconnecting…' : 'Computer unreachable. Check /remote.'
        : e.message || 'Could not connect.', unreachable);
    const label = e.signIn ? 'Sign in' : unreachable ? 'Retry now' : 'Reconnect';
    button.textContent = $('resumeConnection').textContent = label;
    $('resumeConnection').hidden = !inPlace || unreachable;
    if (unreachable) { reconnectFailures++; scheduleReconnect(); }
  } finally {
    clearInterval(countdown);
    $('approvalCode').hidden = $('approvalClock').hidden = true;
    pairing = false;
    if (!leaving) button.disabled = false;
  }
}
async function action(payload, done, failed, command = false, dispatch = message => api('/action',message)) {
  if (!connected || !view) return;
  if (payload.kind === 'stop' || payload.kind === 'interrupt-ask') {
    if (busy && !sendingMessage) return;
    notice(''); return stopping.request(view, payload);
  }
  if (busy) return;
  busy = true;
  sendingMessage = !command && ['send','queue','steer'].includes(payload.kind);
  const generation = view.generation;
  if (payload.kind === 'suggest') dismissed = ''; // an explicit retry may return the same candidate
  controls();
  const feedback = command ? ['Running command…', ''] : {
    'cancel-ask': ['Cancelling question…', 'Question cancelled.'],
    answer: ['Sending answers…', 'Answers sent.'],
    'pull-draft': ['Pulling back pending message…', 'Pulled back · not sent.'],
    'stop-background': ['Stopping background tasks…', 'Stop requested.'],
    'select-model': ['Applying selection…', 'Selection received.'], 'tool-view': ['Updating details…', 'Details updated.'],
  }[payload.kind === 'pull-steer' ? 'pull-draft' : payload.kind];
  // The queue strip is the feedback for a steer/follow-up. HTTP admission is not consumption.
  notice(feedback?.[0] ?? '', true);
  try {
    await dispatch({ generation: view.generation, ...payload });
    done?.();
    notice(feedback?.[1] ?? '');
  } catch (e) {
    // A send whose fate is unknown checks the transcript before saying anything.
    if (!failed?.(e)) notice(e.status === 409 ? e.message : e.message + ' Check before retrying.', true);
  } finally {
    // A newer streamed run already supersedes this send. Don't stall Esc (or
    // reopen an obsolete stream) waiting for another round trip to that state.
    if (!(sendingMessage && connected && (stopping.pending || view?.generation !== generation))) {
      etag = ''; await refresh();
    }
    sendingMessage = false; busy = stopping.pending;
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
// An idle send has an optimistic bubble; steers/follow-ups live only in the queue strip.
// The host owns the transcript. A rejected request stays recoverable in this page.
function clearOutbox() {
  starting.clear();
  dismissed = ''; viewer.close(); sentPhotos.prune([]);
  for (const item of outbox.splice(0)) item.release();
  $('outbox').replaceChildren(); renderQueue(null, outbox);
}
function settleOutbox(s) {
  sentPhotos.prune(s.messages);
  const confirmed = new Set(), spoken = new Map();
  s.messages.forEach((m,i) => {
    if (m.role !== 'user') return;
    if (m.photoId) confirmed.add(m.photoId);
    else spoken.set(m.text, (s.messageOffset ?? 0) + i);
  });
  for (const item of outbox.splice(0)) {
    if (item.sending && item.draftId && delivered(s,item.draftId)) {
      item.confirmBy = 0; item.sending = false;
      if (item.el) item.el.lastElementChild.textContent = 'Sent';
      if (item.kind !== 'send') item.el?.remove();
    }
    if (item.confirmBy) {
      if (Date.now() < item.confirmBy) { outbox.push(item); continue; }
      if (item.el && item.previews.length) failPhoto(item,'Delivery not confirmed.');
      else { item.el?.remove(); item.restore(); transcript.openComposer(); notice('Delivery not confirmed. Draft restored.',true); }
      continue;
    }
    // A repeated message can already be in history. The host queue, not the text or a timeout,
    // decides whether the original draft and its photos must stay recoverable.
    if (item.sending || item.pulling || (item.draftId && pendingDrafts(s)?.includes(item.draftId))) outbox.push(item);
    else if (item.previews.length && confirmed.has(item.draftId)) {
      sentPhotos.remember(item.draftId,item.previews); item.el?.remove(); // history now owns the object URLs
    } else if ((item.kind !== 'send' && item.draftId && pendingDrafts(s)) || (spoken.get(item.text) ?? -1) >= item.firstRow || Date.now() > item.expires) {
      // Missing from an authoritative queue: consumed, edited or removed elsewhere. Only
      // the transcript can speak for consumption. Text/expiry are fallbacks for old hosts.
      item.el?.remove(); item.release();
    } else outbox.push(item);
  }
}
function removeBubble(item) {
  item.el?.remove();
  const index = outbox.indexOf(item);
  if (index >= 0) outbox.splice(index, 1);
}
function pullDraft(draftId) {
  const item = outbox.find(i => i.draftId === draftId);
  if (!item || draftId !== lastDraft(view)) return;
  if ($('draft').value || photos.count) { notice('Clear the current draft before pulling back a pending message.'); return; }
  // Keep the insertion point empty while the host atomically removes the native queue entry.
  $('draft').readOnly = true; item.pulling = true;
  void action({kind:view.pendingDrafts ? 'pull-draft' : 'pull-steer', draftId}, () => {
    if (outbox.includes(item)) { removeBubble(item); item.restore(); transcript.openComposer(); }
  })
    .finally(() => { item.pulling = false; $('draft').readOnly = false; $('draft').focus({preventScroll:true}); });
}
$('send').onclick = () => submitMessage(view?.input, currentSuggestion()?.candidate);
function bubblePhotos(bubble, previews) {
  bubble.querySelector('.bubble-images')?.remove();
  if (!previews.length) return;
  const strip = document.createElement('div'); strip.className = 'bubble-images';
  strip.append(...previews.map(viewer.thumbnail)); bubble.append(strip);
}
function failPhoto(item, reason) {
  removeBubble(item);
  item.el.classList.add('failed'); item.el.querySelector('.bubble-images')?.remove();
  item.el.querySelector('progress')?.remove();
  item.el.lastElementChild.textContent = `${reason} Draft restored.`;
  $('outbox').append(item.el); item.restore(); transcript.openComposer();
}
function sendingBubble(text, previews) {
  const el = document.createElement('article'), bubble = document.createElement('div'), state = document.createElement('small');
  el.className = 'message message-user pending'; bubble.className = 'bubble'; bubble.textContent = text;
  bubblePhotos(bubble,previews);
  state.className = 'outbox-state'; state.textContent = previews.length ? 'Uploading…' : 'Sending…';
  el.append(bubble,state); $('outbox').append(el); return el;
}
function submitMessage(kind, suggested) {
  if (kind === 'queue' && !view?.composerKeys?.queue) return;
  if (!connected || !kind || tab.composing || messageField.readOnly || busy) return;
  // Only the explicit Send button submits a preview. Tab can instead copy it
  // into the draft for editing; status hints are never message text.
  if (!messageField.value && suggested && !photos.count) { messageField.value = suggested; resize(); }
  const text = messageField.value;
  if (!text.trim() && !photos.count) return;
  if (text.length > messageField.maxLength) { notice(`Message is too long (${text.length}/${messageField.maxLength}). Shorten it before sending.`); return; }
  const shortcut = phoneShortcut(text, view.commands, view.slashHints);
  if (shortcut) { if (kind !== 'queue') runShortcut(shortcut); return; }
  const command = phoneLocalCommand(text, view.slashHints);
  if (command) {
    if (photos.count) { notice('Remove the photos before running this command.'); return; }
    if (kind !== 'send') { notice(`Wait for the current run to finish before running ${command}.`); return; }
    const target = terminal, session = view.sessionId;
    // A local command yields notices, not a user-message bubble. Retain the
    // draft on rejection, or if the user starts typing again while admission is pending.
    void action({kind, text: text.trim()}, () => {
      if (terminal === target && view?.sessionId === session && $('draft').value === text) {
        $('draft').value = ''; resize();
      }
    }, undefined, true);
    return;
  }
  if (text && text === view.suggestion) dismissed = text; // sent: do not offer it again
  const taken = photos.take(), n = taken.count, target = terminal, session = view.sessionId, credential = token;
  $('outbox').querySelector('.failed')?.remove();
  // The computer records the turn as text plus this label; match it to retire the pending bubble.
  const shown = [text.trim(), n ? `[${n === 1 ? 'Image' : `${n} images`} from phone]` : ''].filter(Boolean).join('\n');
  const previews = taken.previews();
  const el = kind === 'send' || n ? sendingBubble(shown,previews) : null;
  const draftId = (n > 0 || (kind !== 'send' && pendingDrafts(view))) ? requestId() : undefined;
  const item = {kind, text:shown, el, draftId, firstRow:(view.messageOffset ?? 0) + view.messages.length, previews, sending:true, expires:Date.now()+30000, release:taken.release, restore() {
    taken.restore();
    const d = $('draft');
    // A failed HTTP request can race typing the next draft. Restore both, keep the
    // selection on the new text, and never resubmit automatically.
    if (text && d.value) {
      const prefix = `${text}\n`, start = d.selectionStart, end = d.selectionEnd, direction = d.selectionDirection;
      d.value = prefix + d.value; d.setSelectionRange(start + prefix.length,end + prefix.length,direction);
    } else if (text) d.value = text;
    resize();
  }};
  outbox.push(item);
  const feedback = kind === 'send' && !view.active ? starting.begin(view, n > 0) : null;
  $('draft').value = ''; resize(); $('welcome').hidden = true;
  transcript.submitted({followLatest:!!el});
  const meter = n ? document.createElement('progress') : null;
  if (meter) { meter.max = 100; meter.setAttribute('aria-label','Photo upload'); el.insertBefore(meter,el.lastElementChild); }
  const status = (text, percent = null) => {
    if (el && el.lastElementChild.textContent !== text) el.lastElementChild.textContent = text;
    if (meter) { meter.hidden = percent === null; if (percent !== null) meter.value = percent; }
  };
  let attempted = false;
  void action({kind, text:text.trim(), draftId}, () => {
    item.sending = false; status('Sent'); feedback?.accepted();
    item.expires = Date.now() + 30000;
    if (kind !== 'send') el?.remove(); // admitted; the host queue owns the status now
  }, e => {
    feedback?.failed();
    if (!outbox.includes(item) || !item.sending) return true;
    if (attempted && draftId && !refused(e)) {
      item.confirmBy = Date.now() + CONFIRM_MS; status('Checking delivery…'); return true;
    }
    if (n) { failPhoto(item,e.message); return true; }
    removeBubble(item); item.restore(); transcript.openComposer(); return false;
  }, false, async message => {
    if (n) await taken.ready((ready, label, percent) => {
      if (!outbox.includes(item)) return;
      if (ready.length !== item.previews.length) {
        item.previews = ready;
        bubblePhotos(el.firstElementChild,ready); transcript.keepLatest();
      }
      status(label,percent);
    });
    async function post(allInline) {
      if (!outbox.includes(item)) return;
      const images = n ? await taken.images(allInline) : [];
      if (!outbox.includes(item) || terminal !== target || token !== credential || view?.sessionId !== session)
        throw Error('Conversation changed.');
      const inline = images.some(i => i.data);
      const progress = (loaded,total) => {
        const percent = Math.floor(100 * loaded / total);
        if (loaded === total) status('Waiting for computer…'); else status(`Uploading · ${percent}%`,percent);
      };
      if (inline) progress(0,1); else status('Waiting for computer…');
      attempted = true;
      await api('/action',{...message,...(n ? {images} : {})},{},undefined,inline ? progress : undefined);
    }
    try { await post(false); } catch (e) {
      if (!n || !photoExpired(e)) throw e;
      attempted = false; await post(true); // 412 means the first action never ran
    }
  });
}
// These commands already have native phone controls. Never open an invisible overlay in the followed TUI.
function runShortcut({kind, args}) {
  if (photos.count) { notice('Remove the photos before running this command.'); return; }
  const setDraft = value => { $('draft').value = value; resize(); };
  if (kind === 'sessions') { setDraft(''); drawer.open('', args); }
  if (kind === 'new') { if (args) { notice('Usage: /new'); return; } void showFolders(); }
  if (kind === 'help') {
    setDraft(args ? '/' + args.replace(/^\//, '') : '/'); $('draft').focus();
    if (!commands.browse() && !commands.hint) notice('No matching command in this window. Type / to browse.');
  }
  if (kind === 'model') {
    const select = $('models');
    if (select.disabled) { notice('No models available in this window.'); return; }
    if (!args) {
      setDraft(''); select.focus();
      try { select.showPicker(); } catch { notice('Tap the model name below the message to choose.'); }
    } else {
      if (args === 'n' && !view.models.next) { notice('No next model in this window.'); return; }
      const exact = view.models.options.find(o => o.spec === (args === 'n' ? view.models.next : args));
      const matches = exact ? [exact] : view.models.options.filter(o => o.spec.slice(o.spec.indexOf(':') + 1) === args);
      if (matches.length !== 1) { notice('Choose a configured model from the picker or type its full provider:model name.'); return; }
      const submitted = $('draft').value;
      void action({kind:'select-model', spec:matches[0].spec, revision:view.models.revision}, () => {
        if ($('draft').value === submitted) setDraft('');
      });
    }
  }
}
function resize() {
  const d = $('draft');
  if (d.localName === 'textarea') d.rows = Math.min(5, Math.max(1, d.value.split('\n').length));
  controls();
}
$('draft').oninput = () => { shortcuts.disarm(); resize(); };
if (messageField.isContentEditable) document.addEventListener('selectionchange', () => { if (document.activeElement === messageField) controls(); });
else messageField.addEventListener('selectionchange', controls);
// A photo pasted into the box (desktop browsers, iPad) joins the tray instead of the text.
$('draft').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length && view?.input && !busy) { e.preventDefault(); void photos.add(files); }
});
$('draft').onkeydown = (e) => {
  if (tab.composing || e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Escape') shortcuts.disarm();
  const desktop = matchMedia('(pointer: fine)').matches;
  if (e.key === 'Enter' && !desktop) return; // phone Return is always a newline
  if (tab.keydown(e) || commands.keydown(e) || shortcuts.keydown(e)) return;
  const intent = enterIntent(e, connected && !busy ? view?.input : null, $('draft').value,
    $('draft').selectionStart, desktop);
  if (!intent) return;
  e.preventDefault();
  if (intent === 'continue') {
    const d = $('draft'), start = d.selectionStart;
    applyEdit(d,{start:d.value[start-1] === '\\' ? start-1 : start,end:d.selectionEnd,text:'\n'}); resize();
  }
  if (intent === 'submit') submitMessage(view?.input);
};
// Clicking Send can leave focus on the button (or on body once it disables).
// Native selects/dialogs and an open completion keep first refusal on Escape.
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.target === $('draft') || document.querySelector('dialog[open]') || e.target.closest('select')) return;
  if (view?.ask && (e.target === document.body || e.target.closest('#questions'))) askPanel.keydown(e);
  else if (e.key === 'Escape' && (e.target === document.body || e.target.closest('.task-keys') ||
    (compactComposer.inert ? e.target.closest('#compose') : e.target === $('chat') || compactComposer.contains(e.target)))) shortcuts.keydown(e);
});
$('welcome').onclick = (e) => {
  const prompt = e.target.closest('[data-prompt]')?.dataset.prompt;
  if (prompt) {
    $('draft').value = prompt;
    resize();
    $('draft').focus();
  }
};
$('history').onclick = async (e) => {
  const toggle = e.target.closest('.tool-details');
  if (toggle) {
    if (!view || !connected || busy) return;
    const expanded = toggle.getAttribute('aria-pressed') !== 'true';
    if (view.expanded !== expanded) await action({ kind: 'tool-view', expanded });
    // A reader's transcript stays pinned. An explicit detail toggle updates
    // only the card they chose, not earlier rows or the moving live tail.
    if (toggle.isConnected && view?.expanded === expanded && !updateToolAt(toggle, view)) notice('This tool is outside the current live history.');
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
function refreshOnReturn() {
  if (!document.hidden && token && terminal && view) {
    connected = false;
    etag = ''; // Request a snapshot even when polling: render restores the live controls.
    setLinkStatus('Syncing messages…', true);
    controls();
  }
  void refresh(); // When hidden, this just cancels the current stream and poll timer.
  scheduleReconnect();
}
document.addEventListener('visibilitychange', refreshOnReturn);
window.addEventListener('online', refreshOnReturn);
$('browseSessions').onclick = drawer.open;
$('resumeConnection').onclick = () => void pair();
$('resumeLinked').onclick = () => { if (nav.target?.session) void choose(null, nav.target.session); };
window.addEventListener('pageshow', event => {
  if (event.persisted && leaving) {
    leaving = false;
    const button = $('pair').querySelector('button'); button.disabled = false; button.textContent = 'Continue sign-in';
    needsInteraction = true;
    const inPlace = $('pair-screen').hidden;
    if (inPlace) setLinkStatus('Sign-in wasn’t finished.');
    else $('deviceStatus').textContent = 'Sign-in wasn’t finished.';
    $('resumeConnection').textContent = 'Sign in'; $('resumeConnection').hidden = !inPlace;
  }
});
// A reload of a previously approved chat can also need a fresh credential.
paired(!!token || (!!terminal && (approvedBefore() || !!returnTicket)));
const connectButton = $('pair').querySelector('button');
connectButton.textContent = 'Connect';
connectButton.disabled = false;
$('deviceStatus').textContent = '';
if (!token && (returnTicket || invitedTerminal || approvedBefore())) void pair(approvedBefore() && !returnTicket);
else if (token && !terminal) drawer.open();
else void refresh();
