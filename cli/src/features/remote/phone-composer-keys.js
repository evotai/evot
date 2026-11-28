import { pathToken } from '../../ui/path-token.js';
import { applyEdit } from './phone-editor.js';
import { phoneSkill } from './phone-commands.js';

// Feedback belongs to the same host snapshot as the candidate, but is never draft text.
export function inlineSuggestion(view, empty, dismissed) {
  if (!empty || !view?.input || view.ask) return null;
  const candidate = view.suggestion || '', hint = view.suggestionHint === 'no suggestion' ? '' : view.suggestionHint || '';
  const key = candidate || hint;
  return key && key !== dismissed ? { key, candidate, text: [candidate,hint].filter(Boolean).join('  ') } : null;
}

// One visible hint for both editors. Never put hints in the editable DOM.
export function draftHintText(empty, view, preview, queuedCount) {
  if (!empty) return '';
  if (preview) return preview.text;
  if (queuedCount) return `${queuedCount} ${queuedCount === 1 ? 'message' : 'messages'} queued`;
  if (view?.input === 'steer') return 'Steer the active run…';
  return view?.slashHints || view?.commands?.length ? 'Ask anything, or type / for commands…' : 'Ask anything about this project…';
}

export function tabIntent(view, draft, cursor, {choices, photos, ghost}) {
  if (!view?.input) return null;
  if (choices) return 'Complete';
  if (!draft && !photos) return ghost ? 'Accept' : view.composerKeys?.suggest ? 'Suggest' : null;
  if (!view.composerKeys?.queue || (!draft.trim() && !photos)) return null;
  const before = draft.slice(0,cursor), line = before.slice(before.lastIndexOf('\n') + 1);
  const path = pathToken(line,line.length)?.word;
  if (/(?:^|\s)@\S*$/.test(line) || (path && !/^\d+(?:\/\d+)+$/.test(path))) return null;
  const slash = /^\s*(\/\S+)\s/.exec(draft)?.[1].toLowerCase();
  const skill = slash && phoneSkill(slash, view.commands, view.slashHints);
  return draft.trimStart().startsWith('/') && !skill ? null : 'Send after';
}

// Tab is the only editing shortcut we take from the draft. In particular,
// Shift+Tab still moves focus and Ctrl/Cmd keys still belong to the browser / IME.
export function composerTab(draft, tab, {commands, changed, queue, suggest, disarm}) {
  let intent, ghost, locked, composing = false, compact = false;
  function paint() {
    tab.disabled = compact || !intent || locked || composing || draft.readOnly;
    // An empty, untouched composer is not an invitation to generate a suggestion.
    const focused = draft.ownerDocument?.activeElement;
    tab.hidden = tab.disabled || (intent === 'Suggest' && focused !== draft && focused !== tab);
    if (tab.lastElementChild.textContent !== (intent || '')) tab.lastElementChild.textContent = intent || '';
  }
  // Defer blur until focus has reached the shortcut (keyboard navigation).
  for (const el of [draft, tab]) {
    el.addEventListener('focus', paint);
    el.addEventListener('blur', () => queueMicrotask(paint));
  }
  draft.addEventListener('compositionstart', () => { composing = true; changed(); });
  draft.addEventListener('compositionend', () => { composing = false; changed(); });
  function accept() {
    if (locked || composing || draft.readOnly || draft.value || !ghost) return;
    draft.focus({preventScroll:true}); applyEdit(draft,{start:0,end:0,text:ghost}); changed();
  }
  function invoke() {
    if (tab.disabled || draft.readOnly || !intent) return;
    disarm(); draft.focus({preventScroll:true});
    if (intent === 'Complete') commands.complete();
    else if (intent === 'Send after') queue();
    else if (intent === 'Suggest') suggest();
    else accept();
  }
  tab.onclick = invoke; tab.onmousedown = e => e.preventDefault();
  return { get composing() { return composing; },
    setCompact(value) { compact = value; paint(); },
    render(view, busy, photos, suggestion) {
      locked = busy || !view?.input; ghost = photos ? '' : suggestion;
      intent = tabIntent(view,draft.value,draft.selectionStart,{choices:commands.hasChoices,photos,ghost});
      paint();
    },
    keydown(e) {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229 || composing || tab.disabled) return false;
      e.preventDefault(); if (!e.repeat) invoke(); return true;
    },
  };
}
