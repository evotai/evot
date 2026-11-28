import { InterruptConfirmation } from '../../ui/interrupt-confirmation.js';
import { composerEscape } from '../../ui/composer-escape.js';

// One touch key in the status line, with the same intent as hardware Escape.
export function taskKeys(esc, {act, pull, clear, dismissMenu, interruptAsk}) {
  const timeout = 5000, confirmation = new InterruptConfirmation(Date.now, timeout);
  let owner = null, timer, kind, expandedKind, compactKind, compact = false, pending, view, busy, interruptDuringSend;
  const labels = {dismiss:'Dismiss', 'restore-queued':'Pull back', interrupt:'Stop run', 'interrupt-ask':'Interrupt question and run', 'stop-background':'Stop all background tasks', 'clear-editor':'Clear draft'};
  const isStop = kind => kind === 'interrupt' || kind === 'stop-background';
  function paint() {
    kind = compact ? compactKind : expandedKind;
    const locked = busy && !(interruptDuringSend && kind === 'interrupt');
    const target = kind === 'interrupt' ? 'run' : kind === 'stop-background' ? view.stopBackgroundTarget : null;
    const nextOwner = target && !locked ? JSON.stringify([view.sessionId, view.generation, target]) : null;
    if (owner !== nextOwner) { clearTimeout(timer); confirmation.clear(); }
    owner = nextOwner;
    const armed = isStop(kind) && confirmation.pending(owner);
    esc.hidden = !kind;
    esc.disabled = locked || !kind;
    esc.toggleAttribute('data-confirm', armed);
    const text = armed ? 'Esc again' : 'Esc';
    if (esc.textContent !== text) esc.textContent = text;
    const label = armed ? `Esc again: ${labels[kind]}` : kind ? `Esc: ${labels[kind]}${isStop(kind) ? ' (press twice)' : ''}` : 'Esc';
    if (esc.title !== label) esc.ariaLabel = esc.title = label;
  }
  function disarm() { clearTimeout(timer); confirmation.clear(); paint(); }
  function render(next, locked, draft, draftId, dismissible = false, duringSend = false) {
    view = next; pending = draftId; busy = locked; interruptDuringSend = duringSend;
    const input = {pending:!!pending && !!view?.input, running:view?.input === 'steer', draft:!!draft && !!view?.input,
      interrupt:view?.canStop ? 'agent' : view?.stopBackgroundTarget ? 'background' : null};
    expandedKind = view?.ask ? 'interrupt-ask' : dismissible ? 'dismiss' : composerEscape(input);
    // Reading history must never clear a hidden draft or dismiss a hidden suggestion.
    compactKind = view?.ask ? 'interrupt-ask' : composerEscape({...input, pending:input.pending && !draft, draft:false});
    paint();
  }
  function escape() {
    if (esc.disabled || esc.hidden) return;
    if (kind === 'interrupt-ask') { interruptAsk(); return; }
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
  return { render, keydown, disarm, setCompact(value) { compact = value; paint(); } };
}
