import { needsContinuation } from '../../ui/continuation.js';

// Insert completions through the focused textarea so the browser keeps native undo.
export function applyEdit(draft, {start,end,text}) {
  if (draft.value.length - (end-start) + text.length > draft.maxLength) return;
  draft.setSelectionRange(start,end);
  if (!draft.ownerDocument.execCommand?.('insertText',false,text)) draft.setRangeText(text,start,end,'end');
}

// Software Return and modified keys stay with the browser. Plain desktop Enter sends,
// except for an unfinished code fence or explicit backslash continuation.
export function enterIntent(e, mode, text, cursor, finePointer) {
  if (e.key !== 'Enter' || !finePointer || e.isComposing || e.keyCode === 229 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.repeat || !mode) return 'ignore';
  return mode === 'send' && needsContinuation(text,cursor) ? 'continue' : 'submit';
}
