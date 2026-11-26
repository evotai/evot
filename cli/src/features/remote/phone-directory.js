// Same-origin, paired computer only. The gateway ranks windows and sessions before pagination.
function calendarStamp(now, timeZone) {
  const calendar = zone => Intl.DateTimeFormat('en-US', {
    timeZone:zone, calendar:'gregory', numberingSystem:'latn', year:'numeric', month:'numeric', day:'numeric',
  });
  let dayFormat;
  try { dayFormat = calendar(timeZone); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    dayFormat = calendar(undefined); // Older browsers may not recognize the host's zone name.
  }
  const zone = dayFormat.resolvedOptions().timeZone;
  const clock = Intl.DateTimeFormat(undefined, {timeZone:zone, hour:'2-digit', minute:'2-digit'});
  const date = Intl.DateTimeFormat(undefined, {timeZone:zone, year:'numeric', month:'short', day:'numeric'});
  // Treat the host's calendar date as a UTC day number for comparison only.
  // Subtracting 24 hours from the real instant would mislabel days around DST.
  function dayOf(instant) {
    const parts = dayFormat.formatToParts(instant);
    const number = type => Number(parts.find(part => part.type === type)?.value);
    return Date.UTC(number('year'), number('month') - 1, number('day'));
  }
  const today = dayOf(now), yesterday = today - 86400000;
  return time => {
    if (!time || !Number.isFinite(new Date(time).getTime())) return { day:'other', text:'' };
    const day = dayOf(time);
    if (day === today) return { day:'today', text:clock.format(time) };
    if (day === yesterday) return { day:'yesterday', text:clock.format(time) };
    return { day:'earlier', text:date.format(time) };
  };
}
const groupTitles = { active:'In progress', today:'Today', yesterday:'Yesterday', earlier:'Earlier', other:'Other' };
function directoryPhase(r) {
  if (r.unshared) return 'unshared';
  const phase = r.parked || (!r.terminal && r.kind !== 'private') ? 'history' : r.phase ?? 'idle';
  return r.completed === true && (phase === 'idle' || phase === 'history') ? 'completed' : phase;
}
/** Keep running windows visible, then group the ranked page by host date. */
export function directoryGroups(data, query, {now = Date.now(), timeZone = undefined} = {}) {
  if (!data) return [];
  const stamp = calendarStamp(now, timeZone);
  const groups = { active:[], today:[], yesterday:[], earlier:[], other:[] };
  function add(row) {
    const { day, text } = stamp(row.updatedAt || Date.parse(row.updated));
    const active = ['working','input','busy'].includes(directoryPhase(row));
    const timeLabel = day === 'today' || day === 'yesterday' ? `${groupTitles[day]} · ${text}` : text;
    groups[active ? 'active' : day].push({ ...row, age:active ? timeLabel : text, timeLabel });
  }
  for (const row of data.rows ?? []) add(row);
  if (!query) for (const row of data.privateWindows ?? []) add({...row, kind:'private', title:'Older evot window'});
  return Object.entries(groups).filter(([,rows]) => rows.length).map(([key, rows]) => ({ key, title:groupTitles[key], rows }));
}
// This is state, not an action: a window can be running even while it is
// being viewed, and an unshared window can still be waiting for input.
const phases = { input:'Needs input', working:'Running', busy:'Busy', idle:'Open',
  completed:'Completed', history:'Saved', unshared:'Open, not shared' };
const runStates = { 'waiting-task':'Waiting for task', 'waiting-background':'Background task',
  'waiting-loop':'Loop waiting', retrying:'Retrying', compacting:'Compacting' };
export function windowStatusLabel(r) {
  const phase = directoryPhase(r);
  return (phase === 'working' && runStates[r.runState]) || phases[phase] || 'Open';
}
// A parked phone-created window is not an open session on the computer's desktop.
export function hasOpenWindow(r) {
  return !r.parked && (!!r.terminal || !!r.unshared || r.kind === 'private');
}
export function sessionDrawer({ api, selected, choose, create, createIn, host, ask }) {
  const el = id => document.getElementById(id), dialog = el('sessionsDrawer');
  let timer, timeZone, version = 0, data = null, limit = 40, locked = false, painted = '', error = '', loadingMore = false;
  function row(r) {
    const live = !!r.terminal, statusOnly = r.kind === 'private' || !!r.unshared;
    const button = document.createElement(statusOnly ? 'div' : 'button');
    if (!statusOnly) { button.type = 'button'; button.disabled = locked; }
    button.className = 'terminal-row';
    const current = !statusOnly && live && r.terminal === selected();
    if (current) button.setAttribute('aria-current', 'page');
    // Older windows can report a phase without sharing a session to open.
    const phase = directoryPhase(r), label = windowStatusLabel(r);
    const heading = document.createElement('span'), title = document.createElement('strong'), meta = document.createElement('small');
    heading.className = 'terminal-heading';
    title.textContent = r.title || 'New conversation';
    heading.append(title);
    if (['working','completed','input','busy'].includes(phase)) {
      const badge = document.createElement('span');
      badge.className = 'terminal-status';
      badge.dataset.state = phase;
      badge.title = label;
      if (phase === 'working' || phase === 'completed') {
        badge.setAttribute('role', 'img');
        badge.setAttribute('aria-label', label);
        if (phase === 'completed') badge.textContent = '✓';
        else {
          const glyph = document.createElement('evot-activity');
          glyph.setAttribute('data-running', '');
          glyph.setAttribute('aria-hidden', 'true');
          badge.append(glyph);
        }
      } else badge.textContent = label;
      heading.append(badge);
    }
    const open = hasOpenWindow(r) ? 'Open in evot' : '';
    if (open) {
      const badge = document.createElement('span');
      badge.className = 'terminal-open';
      badge.setAttribute('aria-hidden', 'true'); // Included in the row's accessible name.
      badge.textContent = open;
      heading.append(badge);
    }
    const note = r.unshared ? 'Not shared · run /remote in that window' : r.kind === 'private' ? 'Update evot there' : '';
    meta.textContent = [r.age, r.workspace, note].filter(Boolean).join(' · ');
    const status = r.unshared ? 'Not shared' : open && phase === 'idle' ? '' : label;
    button.setAttribute('aria-label', [title.textContent, open, status, r.workspace, r.timeLabel].filter(Boolean).join(', '));
    button.append(heading, meta);
    if (!statusOnly) button.onclick = () => current ? dialog.close() : choose(r.terminal || null, r.session || null);
    // Saved sessions and idle windows the phone opened can be deleted; the computer closes such a window first.
    return (live && !r.parked) || current || statusOnly || !r.session ? button : deletable(button, r);
  }
  // A trash button on each deletable row removes the session at once, on the computer and
  // for every list. Open windows, the viewed one and status-only rows have none.
  const removing = new Set();
  function deletable(button, r) {
    const wrap = document.createElement('div'), remove = document.createElement('button');
    wrap.className = 'session-row'; wrap.dataset.session = r.session;
    remove.type = 'button'; remove.className = 'row-delete'; remove.disabled = locked;
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
    remove.setAttribute('aria-label', `Delete ${r.title || 'session'}`); remove.title = 'Delete';
    wrap.append(button, remove);
    remove.onclick = async () => {
      if (removing.has(r.session)) return;
      removing.add(r.session); remove.disabled = true; wrap.setAttribute('aria-busy', 'true');
      try {
        await api('/sessions/delete', { session: r.session });
        if (data) data = {...data, rows: data.rows.filter(x => x.session !== r.session), count: Math.max(0, data.count - 1)};
        error = ''; painted = ''; paint(); reload(200);
      } catch (e) {
        wrap.removeAttribute('aria-busy'); remove.disabled = false;
        error = e.message || 'Could not delete the session.'; painted = ''; paint(); reload(1500);
      } finally { removing.delete(r.session); }
    };
    return wrap;
  }
  // Placeholder rows while the computer reads its sessions, so the list has a shape at once.
  function skeleton() {
    return [78, 62, 70, 54, 66].map(width => {
      const row = document.createElement('div'), title = document.createElement('i'), meta = document.createElement('i');
      row.className = 'terminal-row skeleton-row'; row.setAttribute('aria-hidden', 'true');
      title.style.width = width + '%'; meta.style.width = Math.round(width / 2) + '%';
      row.append(title, meta);
      return row;
    });
  }
  function group({key, title, rows}) {
    const section = document.createElement('section'), heading = document.createElement('h3');
    section.className = 'session-group';
    heading.id = 'session-group-' + key;
    heading.textContent = title;
    section.setAttribute('aria-labelledby', heading.id);
    section.append(heading, ...rows.map(row));
    return section;
  }
  function paint() {
    const q = el('sessionSearch').value.trim().toLowerCase();
    const groups = directoryGroups(data, q, {timeZone});
    el('drawerHost').textContent = host() ?? '';
    el('moreSessions').hidden = !data || !data.more;
    el('moreSessions').disabled = loadingMore; el('moreSessions').textContent = loadingMore ? 'Loading…' : 'Load more';
    // The computer's semantic search (/sessions <request>) runs as an agent turn in the followed window.
    const askable = q && ask?.available();
    el('askSearch').hidden = !askable;
    if (askable) el('askSearch').textContent = `Ask evot: /sessions ${q}`;
    el('directoryMessage').textContent = error || (data?.unavailable ? 'A terminal is not responding; saved sessions are temporarily hidden.'
      : data?.failed ? 'Saved sessions unavailable. Retrying…' : '');
    el('archived').textContent = groups.length || error || data?.unavailable || data?.failed || !data ? ''
      : q ? 'No matching sessions.' : 'No sessions yet.';
    const loading = !data && !error;
    const renderKey = JSON.stringify([groups, selected(), locked, loading]);
    if (renderKey !== painted) { painted = renderKey; el('terminals').replaceChildren(...(loading ? skeleton() : groups.map(group))); }
  }
  const current = mine => mine === version && dialog.open && !document.hidden;
  async function load(mine) {
    if (!current(mine)) return;
    const params = new URLSearchParams({limit, catalog:'1', q:el('sessionSearch').value.trim()});
    try {
      const response = await api('/sessions?' + params), result = await response.json();
      if (!current(mine)) return;
      timeZone = response.headers.get('X-Evot-Time-Zone') ?? undefined;
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
  function open(message = '', query = '') {
    const info = el('selectionMessage');
    info.textContent = typeof message === 'string' ? message : ''; info.hidden = !info.textContent;
    limit = 40; data = null; error = ''; el('sessionSearch').value = query;
    if (!dialog.open) dialog.showModal();
    paint(); reload();
  }
  el('sessionSearch').oninput = resetFilter;
  el('moreSessions').onclick = () => { limit += 40; loadingMore = true; paint(); reload(); };
  el('askSearch').onclick = () => { const q = el('sessionSearch').value.trim(); if (q) { dialog.close(); ask.submit(`/sessions ${q}`); } };
  // Only the unusual case needs a word: a local test page served over plain HTTP.
  el('transport').textContent = location.protocol === 'https:' ? '' : 'Not encrypted';
  el('openSessions').onclick = open;
  el('closeSessions').onclick = () => dialog.close();
  dialog.onclose = () => { ++version; clearTimeout(timer); data = null; };
  dialog.onclick = e => { if (e.target === dialog && e.clientX > dialog.getBoundingClientRect().right) dialog.close(); };
  // Swipe the drawer itself left to close it; vertical movement is list scrolling.
  let swipe = null;
  dialog.addEventListener('pointerdown', e => {
    swipe = e.pointerType === 'mouse' || e.target.closest('input, textarea, select') ? null : { x: e.clientX, y: e.clientY, dx: 0, live: false };
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
  el('drawerNew').onclick = () => { dialog.close(); createIn(); };
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
