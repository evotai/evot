import { InterruptConfirmation } from '../../ui/interrupt-confirmation.js';
import { composerEscape } from '../../ui/composer-escape.js';

// The accessory key and a hardware Esc take the same route. The run mode always comes
// from the host; there is no phone-local "stopped" mode that could send to a stale turn.
export function taskKeys(esc, {act, pull, clear, dismissMenu}) {
  const timeout = 5000, confirmation = new InterruptConfirmation(Date.now, timeout);
  let owner = null, timer, kind, pending, view;
  const labels = {dismiss:'Dismiss', 'restore-queued':'Pull back', interrupt:'Stop run', 'stop-background':'Stop all', 'clear-editor':'Clear draft'};
  function paint() {
    const armed = confirmation.pending(owner);
    esc.toggleAttribute('data-confirm', armed);
    esc.lastElementChild.textContent = armed ? 'Confirm stop' : labels[kind] || '';
  }
  function disarm() { clearTimeout(timer); confirmation.clear(); paint(); }
  function render(next, busy, draft, draftId, dismissible = false) {
    view = next; pending = draftId;
    kind = view?.ask ? null : dismissible ? 'dismiss' : composerEscape({pending:!!pending && !!view?.input, running:view?.input === 'steer', draft:!!draft && !!view?.input,
      interrupt:view?.canStop ? 'agent' : view?.stopBackgroundTarget ? 'background' : null});
    const target = kind === 'interrupt' ? 'run' : kind === 'stop-background' ? view.stopBackgroundTarget : null;
    const nextOwner = target && !busy ? JSON.stringify([view.sessionId, view.generation, target]) : null;
    if (owner !== nextOwner) { clearTimeout(timer); confirmation.clear(); }
    owner = nextOwner;
    esc.hidden = !view?.input && !kind;
    esc.disabled = busy || !kind;
    paint();
  }
  function escape() {
    if (kind === 'dismiss') { disarm(); dismissMenu(); return; }
    if (kind === 'restore-queued') { disarm(); pull(pending); return; }
    if (kind === 'clear-editor') { disarm(); clear(); return; }
    if (!owner) return;
    if (confirmation.press(owner)) {
      const payload = kind === 'interrupt' ? {kind:'stop'} : {kind:'stop-background', target:view.stopBackgroundTarget};
      disarm(); void act(payload);
    } else { paint(); clearTimeout(timer); timer = setTimeout(disarm, timeout); }
  }
  esc.onclick = escape;
  esc.onkeydown = e => { if (e.key === 'Enter' && e.repeat) e.preventDefault(); };
  esc.onmousedown = e => e.preventDefault();
  function keydown(e) {
    if (e.isComposing || e.keyCode === 229 || e.altKey || e.metaKey || e.shiftKey) return false;
    if (e.key === 'Escape' && !e.ctrlKey && kind && !esc.disabled) {
      e.preventDefault(); if (!e.repeat) escape(); return true;
    }
    return false;
  }
  return { render, keydown, disarm };
}
