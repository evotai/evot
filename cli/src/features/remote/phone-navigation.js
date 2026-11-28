// The URL names a destination, never an access grant. The window hint also
// addresses a new conversation before its first turn has a session ID.
const terminalId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sessionId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const pendingKey = 'evot.connect.destination';
export function navigation(invite, returning, page, storage, now = Date.now, address = globalThis.location) {
  let pending;
  if (returning) {
    try { pending = JSON.parse(storage.getItem(pendingKey)); } catch { /* stale value */ }
  }
  storage.removeItem(pendingKey);
  const params = new URLSearchParams(address?.search);
  const linked = params.has('window') || params.has('session');
  const fromLink = terminalId(params.get('window')) && (!params.has('session') || sessionId(params.get('session')))
    ? {terminal:params.get('window'), session:params.get('session')} : null;
  let target = terminalId(invite) ? { terminal: invite, session: null }
    : linked ? fromLink : returning && pending?.until > now() ? pending.target : page.state?.evotView;
  function select(terminal, session = null) {
    target = terminalId(terminal) && (session == null || sessionId(session)) ? {terminal, session} : null;
    const url = address && new URL(address.href);
    if (url) {
      for (const [key,value] of [['window',target?.terminal],['session',target?.session]]) {
        if (value) url.searchParams.set(key,value); else url.searchParams.delete(key);
      }
    }
    page.replaceState({...page.state, evotView:target}, '', url?.href);
  }
  select(target?.terminal, target?.session);
  return {
    get target() { return target; }, select,
    redirect() { storage.setItem(pendingKey, JSON.stringify({target, until: now() + 300000})); },
  };
}
