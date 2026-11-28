import { InterruptConfirmation } from '../../ui/interrupt-confirmation.js';
import { composerEscape } from '../../ui/composer-escape.js';

// The accessory key and a hardware Esc take the same route. The run mode always comes
// from the host; there is no phone-local "stopped" mode that could send to a stale turn.
export function taskKeys(esc, {act, pull, clear, dismissMenu, dockAction}) {
  const timeout = 5000, confirmation = new InterruptConfirmation(Date.now, timeout);
  let owner = null, timer, kind, dockKind, pending, view;
  const labels = {dismiss:'Dismiss', 'restore-queued':'Pull back', interrupt:'Stop run', 'stop-background':'Stop all', 'clear-editor':'Clear draft'};
  const isStop = kind => kind === 'interrupt' || kind === 'stop-background';
  function paintButton(button, kind) {
    const armed = isStop(kind) && confirmation.pending(owner), label = armed ? 'Confirm stop' : labels[kind] || '';
    button.toggleAttribute('data-confirm', armed);
    if (button.lastElementChild.textContent !== label) button.lastElementChild.textContent = label;
  }
  function paint() {
    paintButton(esc, kind);
    if (dockAction) paintButton(dockAction, dockKind);
  }
  function disarm() { clearTimeout(timer); confirmation.clear(); paint(); }
  function render(next, busy, draft, draftId, dismissible = false, interruptDuringSend = false) {
    view = next; pending = draftId;
    const input = {pending:!!pending && !!view?.input, running:view?.input === 'steer', draft:!!draft && !!view?.input,
      interrupt:view?.canStop ? 'agent' : view?.stopBackgroundTarget ? 'background' : null};
    kind = view?.ask ? null : dismissible ? 'dismiss' : composerEscape(input);
    // The compact dock never acts on a hidden draft or suggestion. Pullback
    // still takes priority when there is room to restore the queued draft.
    dockKind = dockAction && !view?.ask ? composerEscape({...input, pending:input.pending && !draft, draft:false}) : null;
    const stopKind = isStop(kind) ? kind : dockKind;
    const target = stopKind === 'interrupt' ? 'run' : stopKind === 'stop-background' ? view.stopBackgroundTarget : null;
    const locked = intent => busy && !(interruptDuringSend && intent === 'interrupt');
    const nextOwner = target && !locked(stopKind) ? JSON.stringify([view.sessionId, view.generation, target]) : null;
    if (owner !== nextOwner) { clearTimeout(timer); confirmation.clear(); }
    owner = nextOwner;
    esc.hidden = !view?.input && !kind;
    esc.disabled = locked(kind) || !kind;
    if (dockAction) {
      dockAction.hidden = !dockKind;
      dockAction.disabled = locked(dockKind) || !dockKind;
    }
    paint();
  }
  function escape(kind) {
    if (kind === 'dismiss') { disarm(); dismissMenu(); return; }
    if (kind === 'restore-queued') { disarm(); pull(pending); return; }
    if (kind === 'clear-editor') { disarm(); clear(); return; }
    if (!owner) return;
    if (confirmation.press(owner)) {
      const payload = kind === 'interrupt' ? {kind:'stop'} : {kind:'stop-background', target:view.stopBackgroundTarget};
      disarm(); void act(payload);
    } else { paint(); clearTimeout(timer); timer = setTimeout(disarm, timeout); }
  }
  esc.onclick = () => { if (!esc.disabled) escape(kind); };
  esc.onkeydown = e => { if (e.key === 'Enter' && e.repeat) e.preventDefault(); };
  esc.onmousedown = e => e.preventDefault();
  if (dockAction) {
    dockAction.onclick = () => { if (!dockAction.disabled) escape(dockKind); };
    dockAction.onkeydown = esc.onkeydown;
  }
  function keydown(e, fromDock = false) {
    if (e.isComposing || e.keyCode === 229 || e.altKey || e.metaKey || e.shiftKey) return false;
    const button = fromDock ? dockAction : esc, intent = fromDock ? dockKind : kind;
    if (e.key === 'Escape' && !e.ctrlKey && intent && button && !button.disabled) {
      e.preventDefault(); if (!e.repeat) escape(intent); return true;
    }
    return false;
  }
  return { render, keydown, disarm };
}
