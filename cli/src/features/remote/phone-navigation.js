// A tab reload keeps its current view; a fresh visit to the computer opens Sessions.
// Credentials remain in sessionStorage and are never part of a session link.
const terminalId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const pendingKey = 'evot.connect.destination';
export function navigation(invite, returning, page, storage, now = Date.now) {
  let pending;
  if (returning) {
    try { pending = JSON.parse(storage.getItem(pendingKey)); } catch { /* stale value */ }
  }
  storage.removeItem(pendingKey);
  const saved = page.state?.evotView;
  let target = terminalId(invite) ? { terminal: invite, session: null }
    : returning && pending?.until > now() ? pending.target : saved;
  function select(terminal, session = null) {
    target = terminalId(terminal) ? {terminal, session: typeof session === 'string' && session ? session : null} : null;
    page.replaceState({...page.state, evotView: target}, '');
  }
  select(target?.terminal, target?.session);
  return {
    get target() { return target; }, select,
    redirect() { storage.setItem(pendingKey, JSON.stringify({target, until: now() + 300000})); },
  };
}
