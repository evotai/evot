// The live directory can be briefly empty during a restart. Only reopen an exact,
// visible History entry; /open rechecks occupancy and authorization on the host.
export function sessionRecovery({lookup, open, requestId, now = Date.now}) {
  let episode;
  return {
    reset() { episode = null; },
    async recover(terminal, session, current, progress = () => {}) {
      if (!session || !current()) return null;
      if (episode?.terminal !== terminal || episode.session !== session)
        episode = {terminal, session, next:0, openAfter:now() + 1000, request:requestId(), pending:false, attempts:0};
      const e = episode;
      if (e.pending || now() < e.next) return null;
      const valid = () => episode === e && current();
      e.pending = true;
      try {
        progress('lookup');
        const catalog = await lookup(session);
        if (!valid()) return null;
        // Same row and destination as tapping Sessions. A partial directory
        // can still identify a live shared window, but cannot authorize a launch.
        const row = catalog.rows.find(row => row.session === session);
        if (!row || row.unshared || row.kind === 'private') return null;
        if (row.terminal) return row;
        if (catalog.unavailable || catalog.failed || now() < e.openAfter) return null;
        progress('resume');
        const result = await open({session, requestId:e.request});
        return valid() ? result : null;
      } finally {
        e.pending = false;
        const time = now();
        e.next = time < e.openAfter ? e.openAfter : time + Math.min(30000,2000 * 2 ** Math.min(e.attempts++,4));
      }
    },
  };
}

// A failed stream must get a full snapshot even when session lookup took longer
// than the stream cooldown. Only a successful state reply clears failures.
export const useLiveStream = (failures, pollUntil, now) => !failures && now >= pollUntil;

const stages = {
  identity:'Device · loading key', challenge:'Gateway · requesting challenge', renew:'Account · renewing sign-in',
  signin:'Account · opening sign-in', verify:'Device · signing challenge', proof:'Gateway · verifying device',
  approval:'Device approval', stream:'Gateway · opening live stream', snapshot:'Gateway · requesting snapshot',
  firstFrame:'Session · waiting for first snapshot', sync:'Session · reading snapshot', updates:'Session · live updates',
  lookup:'Session · locating window', resume:'Session · reopening window',
};
export const stageStatus = (stage, detail = '') => detail ? `${stages[stage]}: ${detail}` : `${stages[stage]}…`;

export function retryStatus(e, stage) {
  let reason;
  if (['stream','snapshot','firstFrame','updates','lookup','resume'].includes(stage) && (e.status === 409 || e.status === 404)) reason = `Window unavailable (${e.status})`;
  else if (e.status === 403) reason = 'Access denied (403)';
  else if (e.status) reason = `HTTP ${e.status}`;
  else if (e.name === 'TimeoutError' || e.name === 'AbortError') reason = 'Connection timed out';
  else if (e instanceof TypeError && /fetch|network|load failed|offline/i.test(e.message)) reason = 'Network unavailable';
  else reason = (e.message || 'Connection failed').slice(0, 90).replace(/[.\s]+$/, '');
  return stageStatus(stage, `${reason} · retrying`);
}

export function pairingFeedback(e, stage) {
  if (temporaryDisconnect(e)) return {status:retryStatus(e, stage), retry:true, action:'Retry now'};
  if (e.approvalExpired) return {status:stageStatus(stage, 'Device approval expired.'), retry:false, action:'Request approval'};
  if (e.status === 403) return {status:stageStatus(stage, e.message || 'Device access denied.'), retry:false, action:'Authorize device'};
  const storage = ['SecurityError','QuotaExceededError'].includes(e.name);
  return {status:stageStatus(stage, storage ? 'Enable browser storage to connect.' : e.message || 'Connection unavailable.'), retry:false, action:null};
}

export function temporaryDisconnect(e) {
  return e instanceof TypeError || ['TimeoutError','AbortError'].includes(e.name) ||
    [408,410,425,429].includes(e.status) || e.status >= 500;
}
