// The live directory can be briefly empty during a restart. Only reopen an exact,
// visible History entry; /open rechecks occupancy and authorization on the host.
export function sessionRecovery({lookup, open, requestId, onResume = () => {}, now = Date.now}) {
  let episode;
  return {
    reset() { episode = null; },
    async recover(terminal, session, current) {
      if (!session || !current()) return null;
      if (episode?.terminal !== terminal || episode.session !== session)
        episode = {terminal, session, next:now() + 8000, request:requestId(), pending:false, attempts:0};
      const e = episode;
      if (e.pending || now() < e.next) return null;
      const valid = () => episode === e && current();
      e.pending = true;
      try {
        const rows = await lookup(session);
        if (!valid() || rows.unavailable) return null;
        const owner = rows.online.find(row => row.session === session);
        if (owner) return owner;
        if (!rows.history.some(row => row.session === session)) return null;
        onResume();
        const result = await open({session, requestId:e.request});
        return valid() ? result : null;
      } finally {
        e.pending = false;
        e.next = now() + Math.min(30000, 2000 * 2 ** Math.min(e.attempts++, 4));
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
