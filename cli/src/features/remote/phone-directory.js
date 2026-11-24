// Same-origin, paired computer only. The gateway ranks windows and sessions before pagination.
function age(time, now) {
  if (!time) return '';
  const mins = Math.max(0, Math.floor((now - time) / 60000));
  return mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins/60)}h ago` : `${Math.floor(mins/1440)}d ago`;
}
/** A phone-opened window waiting idle in tmux is not open on the computer; only the
 * one being viewed stays listed. Running or waiting phone windows are listed as usual. */
export const parkedWindow = (w, viewing) => !!w.phoneCreated && w.phase === 'idle' && w.terminal !== viewing;
export function windowRows(online, privateWindows, query, now = Date.now(), viewing = null) {
  return [...online.filter(w => !parkedWindow(w, viewing)).map(w => ({...w, kind:'live'})), ...privateWindows.map(w => ({...w, kind:'private', title:'Older evot window'}))]
    .filter(w => !query || [w.title, w.workspace, w.session].some(s => s?.toLowerCase().includes(query)))
    .map(w => ({...w, age:age(w.updatedAt, now)}));
}
// This is state, not an action: a window can be running even while it is
// being viewed, and an unshared window can still be waiting for input.
const phases = { input:'Needs input', working:'Running', busy:'Busy', idle:'Open' };
const runStates = { 'waiting-task':'Waiting for task', 'waiting-background':'Background task',
  'waiting-loop':'Loop waiting', retrying:'Retrying', compacting:'Compacting' };
export function windowStatusLabel(r) {
  if (r.unshared) return 'Open, not shared';
  if (r.parked || (!r.terminal && r.kind !== 'private')) return 'Saved';
  return (r.phase === 'working' && runStates[r.runState]) || phases[r.phase] || 'Open';
}
export function sessionDrawer({ api, selected, choose, create, ask }) {
  const el = id => document.getElementById(id), dialog = el('sessionsDrawer');
  let timer, version = 0, data = null, mode = 'sessions', limit = 40, locked = false, painted = '', error = '', loadingMore = false;
  function row(r) {
    const live = !!r.terminal, statusOnly = r.kind === 'private' || !!r.unshared;
    const button = document.createElement(statusOnly ? 'div' : 'button');
    if (!statusOnly) { button.type = 'button'; button.disabled = locked; }
    button.className = 'terminal-row';
    const current = live && r.terminal === selected();
    if (current) button.setAttribute('aria-current', 'page');
    button.dataset.phase = r.unshared ? 'unshared' : r.parked ? 'history' : r.phase ?? 'history';
    const heading = document.createElement('span'), title = document.createElement('strong'), badge = document.createElement('span'),
      body = document.createElement('span'), meta = document.createElement('small'), tail = document.createElement('span');
    heading.className = 'terminal-heading';
    title.textContent = r.title || 'New conversation';
    badge.className = 'terminal-status';
    badge.textContent = windowStatusLabel(r);
    heading.append(title, badge);
    body.className = 'terminal-text';
    if (r.session) {
      const id = document.createElement('span'); id.className = 'terminal-id'; id.textContent = r.session; body.append(id);
    }
    meta.textContent = [r.workspace, r.age].filter(Boolean).join(' · ');
    tail.className = 'terminal-tail';
    tail.textContent = r.unshared ? 'Not shared · restart evot or run /remote in that window' : statusOnly ? 'Update evot there' : current ? 'Viewing' : live && !r.parked ? 'Follow' : 'Resume';
    body.append(meta, tail);
    button.append(heading, body);
    if (!statusOnly) button.onclick = () => current ? dialog.close() : choose(r.terminal || null, r.session || null);
    return live || statusOnly || !r.session ? button : swipeable(button, r);
  }
  // Swipe a saved row left to reveal Delete; a click on Delete asks once, then
  // the computer removes the session for every list. Live and status-only rows cannot be deleted here.
  let openRow = null, removing = null;
  function swipeable(button, r) {
    const wrap = document.createElement('div'), remove = document.createElement('button');
    wrap.className = 'swipe-row'; wrap.dataset.session = r.session;
    remove.type = 'button'; remove.className = 'swipe-delete'; remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete session ${r.title || r.session}`);
    wrap.append(button, remove);
    let startX = 0, startY = 0, dx = 0, tracking = false, swiped = false;
    const settle = (open) => { wrap.classList.toggle('open', open); button.style.transform = ''; if (open) { openRow?.classList.remove('open'); openRow = wrap; } else if (openRow === wrap) openRow = null; };
    wrap.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || locked) return; startX = e.clientX; startY = e.clientY; dx = 0; tracking = true; swiped = false; });
    wrap.addEventListener('pointermove', e => {
      if (!tracking) return;
      const x = e.clientX - startX, y = e.clientY - startY;
      if (!swiped && Math.abs(y) > Math.abs(x)) { tracking = false; return; }
      if (Math.abs(x) > 8) swiped = true;
      dx = Math.max(-96, Math.min(wrap.classList.contains('open') ? 96 : 0, x));
      if (swiped) button.style.transform = `translateX(${wrap.classList.contains('open') ? -96 + dx : dx}px)`;
    });
    const end = () => { if (!tracking) return; tracking = false; if (swiped) settle(wrap.classList.contains('open') ? dx < 48 : dx < -40); };
    wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
    button.addEventListener('click', e => { if (swiped || wrap.classList.contains('open')) { e.stopImmediatePropagation(); e.preventDefault(); settle(false); } }, true);
    remove.onclick = async () => {
      if (removing) return;
      removing = r.session; remove.disabled = true; remove.textContent = 'Deleting…'; wrap.setAttribute('aria-busy', 'true');
      try {
        await api('/sessions/delete', { session: r.session });
        if (data) data = {...data, rows: data.rows.filter(x => x.session !== r.session), count: Math.max(0, data.count - 1)};
        error = ''; painted = ''; paint(); reload(200);
      } catch (e) {
        error = e.message || 'Could not delete the session.'; paint(); reload(1500);
      } finally { removing = null; }
    };
    return wrap;
  }
  function paint() {
    const q = el('sessionSearch').value.trim().toLowerCase(), windows = mode === 'windows';
    const now = Date.now();
    const rows = windows ? windowRows(data?.online ?? [], data?.privateWindows ?? [], q, now, selected())
      : (data?.rows ?? []).map(r => ({...r, age:age(Date.parse(r.updated), now)}));
    el('listLabel').textContent = windows ? 'Open windows' : 'All sessions';
    el('showWindows').setAttribute('aria-pressed', String(windows));
    el('showCatalog').setAttribute('aria-pressed', String(!windows));
    el('showWindows').textContent = data ? `Open windows · ${data.online.filter(w => !parkedWindow(w, selected())).length + data.privateWindows.length}` : 'Open windows';
    el('terminalCount').textContent = data ? String(windows ? rows.length : data.more ? `${rows.length}+` : rows.length) : '…';
    el('moreSessions').hidden = windows || !data || !data.more;
    el('moreSessions').disabled = loadingMore; el('moreSessions').textContent = loadingMore ? 'Loading…' : 'Load more';
    // The computer's semantic search (/sessions <request>) runs as an agent turn in the followed window.
    const askable = !windows && q && ask?.available();
    el('askSearch').hidden = !askable;
    if (askable) el('askSearch').textContent = `Ask evot: /sessions ${q}`;
    el('directoryMessage').textContent = error || (data?.unavailable ? 'A terminal is not responding; saved sessions are temporarily hidden.'
      : data?.failed ? 'Saved sessions unavailable. Retrying…' : '');
    el('archived').textContent = rows.length || error || data?.unavailable || data?.failed ? '' : !data ? 'Loading…' : windows ? 'No matching windows.'
      : q ? 'No matching sessions.' : 'No sessions yet.';
    const renderKey = JSON.stringify([rows, selected(), locked]);
    if (renderKey !== painted) { painted = renderKey; el('terminals').replaceChildren(...rows.map(row)); }
  }
  const current = mine => mine === version && dialog.open && !document.hidden;
  async function load(mine) {
    if (!current(mine)) return;
    const params = new URLSearchParams({limit, catalog:'1', q:el('sessionSearch').value.trim()});
    try {
      const result = await (await api('/sessions?' + params)).json();
      if (!current(mine)) return;
      data = result; error = ''; loadingMore = false;
    } catch {
      loadingMore = false;
      if (!current(mine)) return;
      data = null; error = 'Could not refresh sessions. Retrying…';
    }
    paint();
    timer = setTimeout(() => load(mine), 1800);
  }
  function reload(delay = 0) {
    clearTimeout(timer);
    const mine = ++version;
    if (!current(mine)) return;
    timer = setTimeout(() => load(mine), delay);
  }
  function resetFilter() {
    limit = 40; error = '';
    if (data) data = {...data, count:0, rows:[]};
    paint(); reload(120);
  }
  function open(message = '') {
    const info = el('selectionMessage');
    info.textContent = typeof message === 'string' ? message : ''; info.hidden = !info.textContent;
    mode = 'sessions'; limit = 40; data = null; error = ''; el('sessionSearch').value = '';
    if (!dialog.open) dialog.showModal();
    paint(); reload();
  }
  el('sessionSearch').oninput = resetFilter;
  el('showWindows').onclick = () => { mode = 'windows'; paint(); };
  el('showCatalog').onclick = () => { mode = 'sessions'; paint(); };
  el('moreSessions').onclick = () => { limit += 40; loadingMore = true; paint(); reload(); };
  el('askSearch').onclick = () => { const q = el('sessionSearch').value.trim(); if (q) { dialog.close(); ask.submit(`/sessions ${q}`); } };
  el('transport').textContent = location.protocol === 'https:' ? 'HTTPS · encrypted' : 'HTTP · not encrypted';
  el('openSessions').onclick = open;
  el('closeSessions').onclick = () => dialog.close();
  dialog.onclose = () => { ++version; clearTimeout(timer); data = null; };
  dialog.onclick = e => { if (e.target === dialog && e.clientX > dialog.getBoundingClientRect().right) dialog.close(); };
  // Swipe the drawer itself left to close it. A swipe that starts on a saved row
  // belongs to that row's Delete gesture; vertical movement is list scrolling.
  let swipe = null;
  dialog.addEventListener('pointerdown', e => {
    swipe = e.pointerType === 'mouse' || e.target.closest('.swipe-row, input, textarea, select') ? null : { x: e.clientX, y: e.clientY, dx: 0, live: false };
  });
  dialog.addEventListener('pointermove', e => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (!swipe.live && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (dx < -10) swipe.live = true;
    swipe.dx = dx;
    if (swipe.live) dialog.style.transform = `translateX(${Math.min(0, dx)}px)`;
  });
  const endSwipe = () => {
    if (!swipe) return;
    const close = swipe.live && swipe.dx < -Math.min(90, dialog.getBoundingClientRect().width / 3);
    swipe = null; dialog.style.transform = '';
    if (close) dialog.close();
  };
  dialog.addEventListener('pointerup', endSwipe); dialog.addEventListener('pointercancel', endSwipe);
  document.addEventListener('visibilitychange', () => reload());
  el('drawerNew').onclick = create;
  el('newSession').onclick = create;
  return {
    open,
    lock(value) { if (value !== locked) { locked = value; if (dialog.open) paint(); } },
    reset() {
      ++version; clearTimeout(timer); data = null; locked = false; error = ''; painted = '';
      if (dialog.open) dialog.close();
      paint();
    },
    close: () => dialog.close(),
    get visible() { return dialog.open; },
  };
}
