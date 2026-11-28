// The live stream may settle the turn before the stop POST returns. Only the
// owner of this stop may unlock the composer or replace its stream baseline.
export function runInterrupt({lock, post, replace, refresh, error}) {
  let pending;
  function clear() {
    if (!pending) return;
    pending = null; lock(false);
  }
  return {
    get pending() { return !!pending; }, clear,
    observe(view) {
      if (pending && (view.sessionId !== pending.sessionId || view.generation !== pending.generation || view.input === 'send')) clear();
    },
    async request(view, action) {
      if (pending) return;
      const turn = pending = {sessionId:view.sessionId,generation:view.generation};
      lock(true);
      try {
        const state = await post({generation:turn.generation,...action});
        if (pending !== turn) return;
        if (state) { replace(state); if (pending === turn) clear(); return; }
      } catch (e) {
        if (pending !== turn) return;
        error(e); // Never retry a stop on a possibly different run.
      }
      // Old gateway (204) or ambiguous outcome: wait for a fresh full view.
      try { await refresh(); } finally { if (pending === turn) clear(); }
    },
  };
}
