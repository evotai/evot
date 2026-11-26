// A restarted gateway can serve a newer page. The open page reloads once to
// pick it up, and the unsent draft rides along through that reload, a sign-in
// redirect or a silent re-pairing. Tab-scoped storage only; it never leaves the phone.
const DRAFT = 'evot.remote.draft', RELOADED = 'evot.remote.reloadedFor';
const DRAFT_TTL_MS = 10 * 60 * 1000;

export function draftCarry(storage, now = Date.now) {
  return {
    keep(terminal, text) {
      try {
        if (terminal && text) storage.setItem(DRAFT, JSON.stringify({terminal, text, at: now()}));
      } catch { /* Storage blocked or full: the draft stays only in this page. */ }
    },
    /** The draft kept for this window, once. Another window's draft stays put. */
    take(terminal) {
      try {
        const saved = JSON.parse(storage.getItem(DRAFT) ?? 'null');
        if (!saved || saved.terminal !== terminal) return '';
        storage.removeItem(DRAFT);
        return typeof saved.text === 'string' && now() - saved.at < DRAFT_TTL_MS ? saved.text : '';
      } catch { return ''; }
    },
  };
}

/** Returns a check for each reply's build. It reloads at most once per served
 * build, so a cached old page can never loop. */
export function pageUpdates(current, storage, reload) {
  return served => {
    if (!served || !current || served === current) return false;
    try {
      if (storage.getItem(RELOADED) === served) return false;
      storage.setItem(RELOADED, served);
    } catch { return false; }
    reload();
    return true;
  };
}
