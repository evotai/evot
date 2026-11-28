// Reload only a failing, outdated page, at most once for this build in the tab.
export function reloadForRecovery({page, gateway, failures, protectedWork, storage, saveDraft}) {
  if (failures < 2 || protectedWork || !page || !/^[\w-]{16}$/.test(gateway ?? '') || page === gateway) return false;
  const key = 'evot.remote.reloadedBuild';
  try {
    if (storage.getItem(key) === gateway || !saveDraft()) return false;
    storage.setItem(key, gateway);
    return true;
  } catch { return false; }
}

// Carry an unsent draft through sign-in or a gateway update. Tab-scoped; it never leaves the phone.
const DRAFT = 'evot.remote.draft';
const DRAFT_TTL_MS = 10 * 60 * 1000;

export function draftCarry(storage, now = Date.now) {
  return {
    keep(terminal, text) {
      try {
        if (!text) return true;
        if (!terminal) return false;
        storage.setItem(DRAFT, JSON.stringify({terminal, text, at: now()}));
        return true;
      } catch { return false; }
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
