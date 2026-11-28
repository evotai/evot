// The live directory can be briefly empty during a restart. Only reopen an exact,
// visible History entry; /open rechecks occupancy and authorization on the host.
export function sessionRecovery({lookup, open, requestId, onResume = () => {}, now = Date.now}) {
  let episode;
  return {
    reset() { episode = null; },
    async recover(terminal, session, current) {
      if (!session || !current()) return null;
      if (episode?.terminal !== terminal || episode.session !== session)
        episode = {terminal, session, next:0, openAfter:now() + 1000, request:requestId(), pending:false, attempts:0};
      const e = episode;
      if (e.pending || now() < e.next) return null;
      const valid = () => episode === e && current();
      e.pending = true;
      try {
        const catalog = await lookup(session);
        if (!valid()) return null;
        // Same row and destination as tapping Sessions. A partial directory
        // can still identify a live shared window, but cannot authorize a launch.
        const row = catalog.rows.find(row => row.session === session);
        if (!row || row.unshared || row.kind === 'private') return null;
        if (row.terminal) return row;
        if (catalog.unavailable || catalog.failed || now() < e.openAfter) return null;
        onResume();
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

// Only actions that actually require the person belong next to the status line.
export function pairingFeedback(e) {
  if (temporaryDisconnect(e)) return {status:'Reconnecting…', retry:true, action:null};
  if (e.signIn) return {status:'Sign-in required.', retry:false, action:'Sign in'};
  if (e.approvalExpired) return {status:'Device approval expired.', retry:false, action:'Request approval'};
  if (e.status === 403) return {status:e.message || 'Device access denied.', retry:false, action:'Authorize device'};
  const storage = ['SecurityError','QuotaExceededError'].includes(e.name);
  return {status:storage ? 'Enable browser storage to connect.' : e.message || 'Connection unavailable.', retry:false, action:null};
}

export function temporaryDisconnect(e) {
  return e instanceof TypeError || ['TimeoutError','AbortError'].includes(e.name) ||
    [408,410,425,429].includes(e.status) || e.status >= 500;
}
