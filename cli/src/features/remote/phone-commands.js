import { applyEdit } from './phone-editor.js';
import { isSessionIdPrefix, normalizeResumeQuery } from '../../session/resume-query.js';
import { matchCatalogPrefix, resolveSpelling, slashCompletion } from '../composer/slash-completion.js';
import { argumentCompletion } from '../composer/command-arguments.js';
import { remoteLocalCommand } from './local-commands.js';

function legacyCommand(token, commands) {
  return commands?.find(c => token.startsWith(c.prefix) && c.name.toLowerCase().startsWith(token));
}
function currentCommand(token, hints) {
  if (!token.startsWith('/')) return null;
  const matches = resolveSpelling(matchCatalogPrefix(hints.catalog, token), token);
  return matches.length === 1 ? matches[0] : null;
}
export function phoneSkill(token, commands, hints) {
  if (hints) return currentCommand(token, hints)?.handler === 'skill';
  const command = legacyCommand(token, commands);
  return !!command && !command.shortcut;
}
export function phoneLocalCommand(text, hints) {
  const token = text.trim().split(/\s+/,1)[0].toLowerCase();
  const name = hints ? currentCommand(token, hints)?.name : token;
  return remoteLocalCommand(name) ? name : null;
}
export function phoneShortcut(text, commands, hints) {
  const [token, ...rest] = text.trim().split(/\s+/), key = token.toLowerCase();
  const canonical = hints && currentCommand(key, hints)?.name;
  const command = hints ? commands?.find(c => c.name === canonical) : legacyCommand(key, commands);
  const kind = command?.shortcut;
  if (!kind) return null;
  const args = rest.join(' ');
  if (kind === 'sessions') {
    const query = normalizeResumeQuery(args);
    // A natural-language search is an agent turn; a lookup stays in the phone drawer.
    if (query && query !== '--all' && !isSessionIdPrefix(query)) return null;
    return { kind: 'sessions', args: query === '--all' ? '' : query };
  }
  return { kind, args };
}

/** New windows ship the same display grammar and argument inventory used by the
 * TUI. A completion only edits a range of the local draft. */
export function sharedChoices(text, cursor, hints) {
  const {catalog, forked, inventory} = hints;
  const before = text.slice(0, cursor), lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', cursor), after = text.slice(cursor, lineEnd < 0 ? undefined : lineEnd);
  const line = before.slice(lineStart), input = line.trimStart(), indent = line.length - input.length;
  const slash = slashCompletion(input, catalog, forked);
  const hint = !indent && !after.trim() ? slash?.hint ?? '' : '';
  // The configured picker takes precedence on Tab, not in the passive hint.
  const args = argumentCompletion(text, cursor, inventory, catalog);
  if (args) return {items: args.items.map(item => ({label:item.label, detail:item.description, value:item.value})),
    hint, note:args.note, start:args.start, end:args.end, replacement:null};
  const start = lineStart + indent + (slash?.wordStart ?? 0);
  return {items:slash?.choices ?? [], hint, start, end:cursor, replacement:slash?.replacement ?? null};
}

// Fallback for windows predating the shared grammar; the original field is unchanged.
export function commandChoices(text, commands, models = []) {
  const items = [];
  let hint = '';
  const input = text.trimStart();
  if (!input.startsWith('/') || !commands?.length) return { items, hint };
  const [token, arg, ...rest] = input.split(/\s+/), key = token.toLowerCase();
  if (arg === undefined) {
    const builtin = legacyCommand(key, commands)?.shortcut;
    for (const cmd of commands) if ((!builtin || cmd.shortcut) && cmd.name.toLowerCase().startsWith(key)) {
      items.push({ label: cmd.name, detail: cmd.description, value: `${cmd.name} ` });
    }
  } else if (!rest.length) {
    const cmd = legacyCommand(key, commands);
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

export function phoneCompletion(text, cursor, end, view) {
  if (!view || cursor !== end) return null;
  if (view.slashHints) return sharedChoices(text, cursor, view.slashHints);
  if (cursor !== text.length) return null;
  const {items, hint} = commandChoices(text, view.commands, view.models?.options);
  const suffix = items.length === 1 && items[0].value.toLowerCase().startsWith(text.toLowerCase())
    ? items[0].value.slice(text.length).trimEnd() : '';
  return {items, start:0, end:cursor, replacement:items.length === 1 ? items[0].value : null,
    hint:suffix || (hint ? `  ${hint}` : items.length > 1 ? `  [${items.map(item => item.label).join('  ')}]` : '')};
}

/** A passive ghost is never a menu. Only Tab (or the touch completion key)
 * opens choices, so typing, Enter, and caret navigation stay native. */
export function commandMenu(draft, panel, changed) {
  let painted = '', source = '', dismissed = null, opened = false, selected = 0, edit = null;
  function highlight(scroll) {
    const buttons = panel.querySelectorAll('button');
    buttons.forEach((b,i) => b.toggleAttribute('data-current', i === selected));
    if (scroll) buttons[selected]?.scrollIntoView({block:'nearest'});
    if (buttons[selected]) draft.setAttribute('aria-activedescendant', buttons[selected].id);
    else draft.removeAttribute('aria-activedescendant');
  }
  function apply(text) {
    const {start,end} = edit;
    opened = false;
    draft.focus({preventScroll:true}); applyEdit(draft,{start,end,text}); changed();
  }
  function render(view) {
    const {value, selectionStart:cursor, selectionEnd:end} = draft;
    const next = JSON.stringify([value,cursor,end]);
    if (source !== next || !view) { source = next; opened = false; }
    if (dismissed !== source) dismissed = null;
    edit = dismissed === null ? phoneCompletion(value,cursor,end,view) : null;
    const items = opened ? edit?.items ?? [] : [], note = opened ? edit?.note : '';
    const key = JSON.stringify([items, note]);
    if (key === painted) return;
    painted = key;
    panel.replaceChildren(); panel.hidden = !items.length && !note;
    const doc = panel.ownerDocument;
    if (note) {
      const line = doc.createElement('small'); line.textContent = note; panel.append(line);
    }
    selected = 0;
    for (const [i,item] of items.entries()) {
      const b = doc.createElement('button'); b.type = 'button'; b.id = `completion-${i}`;
      const name = doc.createElement('strong'); name.textContent = item.label; b.append(name);
      if (item.detail) { const detail = doc.createElement('span'); detail.textContent = item.detail; b.append(detail); }
      b.onmousedown = e => e.preventDefault(); // keep the software keyboard and caret
      b.onclick = () => apply(item.value);
      b.onfocus = () => { selected = i; highlight(false); };
      panel.append(b);
    }
    panel.scrollTop = 0; highlight(false);
  }
  function dismiss() {
    if (panel.hidden && !edit?.hint) return false;
    dismissed = source; opened = false; draft.focus({preventScroll:true}); changed(); return true;
  }
  function browse() {
    if (!edit?.items.length && !edit?.note) return false;
    opened = true; changed(); return true;
  }
  function complete() {
    if (opened && edit?.items[selected]) apply(edit.items[selected].value);
    else if (edit?.replacement != null && edit.replacement !== draft.value.slice(edit.start,edit.end)) {
      const many = edit.items.length > 1;
      apply(edit.replacement);
      if (many) browse();
    } else browse();
  }
  function keydown(e) {
    if (e.isComposing || e.keyCode === 229 || panel.hidden || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
    const count = edit?.items.length ?? 0;
    if (!count) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
      draft.focus({preventScroll:true}); highlight(true);
    } else if (e.key === 'Enter' && e.target === draft) {
      if (!e.repeat) complete();
    } else return false;
    e.preventDefault(); return true;
  }
  panel.addEventListener('keydown', keydown);
  return { render, keydown, dismiss, complete, browse,
    get hint() { return panel.hidden ? edit?.hint || '' : ''; },
    get hasChoices() { return !!(edit?.items.length || edit?.note); } };
}
