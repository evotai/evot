// Carry an unsent draft through an explicit sign-in. Tab-scoped; it never leaves the phone.
const DRAFT = 'evot.remote.draft';
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
