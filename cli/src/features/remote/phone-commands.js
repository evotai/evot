import { applyEdit } from './phone-editor.js';
import { isSessionIdPrefix, normalizeResumeQuery } from '../../session/resume-query.js';

// The TUI supplies both the inventory and the prefixes it recognizes. No draft keystrokes leave the phone.
function resolved(token, commands) {
  return commands?.find(c => token.startsWith(c.prefix) && c.name.toLowerCase().startsWith(token));
}
export function phoneShortcut(text, commands) {
  const [token, ...rest] = text.trim().split(/\s+/), cmd = resolved(token.toLowerCase(), commands);
  if (!cmd?.shortcut) return null;
  const args = rest.join(' ');
  if (cmd.shortcut === 'sessions') {
    const query = normalizeResumeQuery(args);
    // A natural-language search is an agent turn; a lookup stays in the phone drawer.
    if (query && query !== '--all' && !isSessionIdPrefix(query)) return null;
    return { kind: 'sessions', args: query === '--all' ? '' : query };
  }
  return { kind: cmd.shortcut, args };
}

export function commandChoices(text, commands, models = []) {
  const items = [];
  let hint = '';
  const input = text.trimStart();
  if (!input.startsWith('/') || !commands?.length) return { items, hint };
  const [token, arg, ...rest] = input.split(/\s+/), key = token.toLowerCase();
  if (arg === undefined) {
    const builtin = resolved(key, commands)?.shortcut;
    for (const cmd of commands) if ((!builtin || cmd.shortcut) && cmd.name.toLowerCase().startsWith(key)) {
      items.push({ label: cmd.name, detail: cmd.description, value: `${cmd.name} ` });
    }
  } else if (!rest.length) {
    const cmd = resolved(key, commands);
    if (cmd) {
      if (!arg) hint = cmd.usage || cmd.description;
      if (cmd.shortcut === 'model') {
        const query = arg.toLowerCase();
        for (const {spec, label} of models) if (spec.toLowerCase().startsWith(query) || label.toLowerCase().includes(query))
          items.push({label:spec, detail:label, value:`${cmd.name} ${spec} `});
      }
      for (const literal of cmd.arguments ?? []) if (!literal.startsWith('<') && literal.toLowerCase().startsWith(arg.toLowerCase())) {
        items.push({ label: literal, value: `${cmd.name} ${literal} ` });
      }
    }
  }
  return { items, hint };
}

/** A passive hint must not intercept Enter on an already complete command. Browsing
 * promotes it to a menu; then Enter/Tab both confirm, including during a run. */
export function completionGesture(key, count, selected, browsed, exact) {
  if (!count) return null;
  if (key === 'ArrowDown' || key === 'ArrowUp') return {index:(selected + (key === 'ArrowDown' ? 1 : -1) + count) % count};
  if (key === 'Tab' || (key === 'Enter' && (browsed || !exact))) return {accept:true};
  return null;
}

/** The draft keeps focus while arrows browse candidates. Confirm edits the draft, never sends. */
export function commandMenu(draft, panel, changed) {
  let painted = '', dismissed = null, selected = 0, browsed = false, exact = false;
  function highlight(scroll) {
    const buttons = panel.querySelectorAll('button');
    buttons.forEach((b,i) => b.toggleAttribute('data-current', i === selected));
    if (scroll) buttons[selected]?.scrollIntoView({block:'nearest'});
    if (buttons[selected]) draft.setAttribute('aria-activedescendant', buttons[selected].id);
    else draft.removeAttribute('aria-activedescendant');
  }
  function render(commands, models) {
    if (draft.value !== dismissed) dismissed = null;
    const { items, hint } = commandChoices(draft.value,
      draft.selectionStart === draft.value.length && dismissed === null ? commands : null, models);
    const typed = draft.value.trim().toLowerCase();
    exact = commands?.some(c => c.name.toLowerCase() === typed) || items.some(i => i.value.trim().toLowerCase() === typed);
    const key = JSON.stringify([draft.value,items,hint]);
    if (key === painted) return;
    painted = key;
    panel.replaceChildren(); panel.hidden = !items.length && !hint;
    if (hint) {
      const note = document.createElement('small'); note.textContent = hint; panel.append(note);
    }
    selected = 0; browsed = false;
    for (const [i,item] of items.entries()) {
      const b = document.createElement('button'); b.type = 'button'; b.id = `completion-${i}`;
      const name = document.createElement('strong'); name.textContent = item.label; b.append(name);
      if (item.detail) { const detail = document.createElement('span'); detail.textContent = item.detail; b.append(detail); }
      b.onmousedown = e => e.preventDefault(); // keep the software keyboard and caret
      b.onclick = () => { draft.focus({preventScroll:true}); applyEdit(draft,{start:0,end:draft.value.length,text:item.value}); changed(); };
      // The widget itself still supports ordinary focus navigation and Enter to click.
      b.onfocus = () => { selected = i; highlight(false); };
      panel.append(b);
    }
    panel.scrollTop = 0; highlight(false);
  }
  function dismiss() {
    if (panel.hidden) return false;
    dismissed = draft.value; render(null); draft.focus(); changed(); return true;
  }
  function complete() {
    const options = panel.querySelectorAll('button');
    if (panel.hidden || !options.length) return false;
    options[selected].click();
    return true;
  }
  function keydown(e) {
    if (e.isComposing || e.keyCode === 229 || panel.hidden) return false;
    if (e.key === 'Escape') {
      e.preventDefault(); return dismiss();
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
    const gesture = completionGesture(e.key,panel.querySelectorAll('button').length,selected,browsed,exact);
    if (!gesture) return false;
    if (gesture.accept) {
      if (e.target !== draft) return false; // native button activation / focus traversal
      if (!e.repeat) complete();
    } else {
      selected = gesture.index; browsed = true;
      draft.focus({preventScroll:true}); highlight(true);
    }
    e.preventDefault(); return true;
  }
  panel.addEventListener('keydown', keydown);
  return { render, keydown, dismiss, complete, get hasChoices() { return !panel.hidden && !!panel.querySelector('button'); } };
}
