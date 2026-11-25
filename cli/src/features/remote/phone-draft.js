// Mobile browsers can offer password/card/address filling for a textarea even with
// autocomplete=off. Use a native plaintext editing host, not a form control or a
// custom keyboard. Desktop and browsers without plaintext-only keep the textarea.
export function installTouchDraft(textarea, limitReached) {
  if (!matchMedia('(any-pointer: coarse)').matches) return textarea;
  const probe = document.createElement('div');
  probe.setAttribute('contenteditable','plaintext-only');
  if (probe.contentEditable !== 'plaintext-only') return textarea;

  class MessageDraft extends HTMLElement {
    get value() { return draftLayout(this).text; }
    set value(text) {
      this.textContent = text;
      // Represent the final empty line separately from the real newline in the text.
      if (text.endsWith('\n')) this.append(document.createElement('br'));
    }
    get maxLength() { return textarea.maxLength; }
    get readOnly() { return this.contentEditable === 'false'; }
    set readOnly(value) { this.contentEditable = value ? 'false' : 'plaintext-only'; }
    get selectionStart() { return caret(this,'start'); }
    get selectionEnd() { return caret(this,'end'); }
    get selectionDirection() {
      const s = getSelection();
      return s?.rangeCount && !s.isCollapsed && s.anchorNode === s.getRangeAt(0).endContainer && s.anchorOffset === s.getRangeAt(0).endOffset ? 'backward' : 'forward';
    }
    setSelectionRange(start,end,direction) {
      const layout = draftLayout(this), a = layout.point(start), b = layout.point(end);
      const [anchor,focus] = direction === 'backward' ? [b,a] : [a,b];
      getSelection()?.setBaseAndExtent(...anchor,...focus);
    }
    setRangeText(text,start,end) {
      this.value = this.value.slice(0,start) + text + this.value.slice(end);
      this.setSelectionRange(start+text.length,start+text.length);
    }
  }
  customElements.define('evot-message-draft',MessageDraft);
  const draft = document.createElement('evot-message-draft');
  for (const name of ['id','aria-label','aria-controls','aria-describedby','autocorrect','autocapitalize','spellcheck','writingsuggestions'])
    draft.setAttribute(name,textarea.getAttribute(name));
  draft.setAttribute('role','textbox'); draft.setAttribute('aria-multiline','true');
  draft.contentEditable = 'plaintext-only';
  draft.value = textarea.value;
  draft.addEventListener('beforeinput', e => {
    // Do not cancel IME updates or rewrite the live DOM: some compositions and
    // undo operations are not cancelable. Submission checks the limit as well.
    if (e.isComposing || !e.cancelable || !e.inputType.startsWith('insert')) return;
    const inserted = ['insertParagraph','insertLineBreak'].includes(e.inputType) ? '\n'
      : e.data ?? e.dataTransfer?.getData('text/plain');
    if (inserted == null) return;
    const layout = draftLayout(draft), selection = getSelection();
    const range = e.getTargetRanges?.()[0] ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
    const replaced = range ? layout.offset(range.endContainer,range.endOffset) - layout.offset(range.startContainer,range.startOffset) : 0;
    if (inserted.length > replaced && layout.text.length - replaced + inserted.length > draft.maxLength) {
      e.preventDefault(); limitReached(draft.maxLength);
    }
  });
  textarea.replaceWith(draft);
  return draft;
}

// Plaintext-only still has DOM carets. WebKit can use BR/block lines and Blink
// leaves a final BR or LF as a caret placeholder. Map both to textarea UTF-16
// offsets, without normalizing the live DOM (which would cancel composition/undo).
export function draftLayout(root) {
  let text = '';
  const spans = [], offsets = new Map();
  function visit(parent) {
    const bounds = [text.length]; offsets.set(parent,bounds);
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) {
        const value = !n.nextSibling && n.data === '\n' ? '' : n.data;
        spans.push({node:n,start:text.length,length:value.length}); text += value;
      } else if (n.nodeName === 'BR') {
        if (n.nextSibling) text += '\n';
      } else {
        if ((n.nodeName === 'DIV' || n.nodeName === 'P') && n.previousSibling) text += '\n';
        visit(n);
      }
      bounds.push(text.length);
    }
  }
  visit(root);
  return {text,
    offset(node,pos) {
      const span = spans.find(s => s.node === node);
      return span ? span.start + Math.min(pos,span.length) : offsets.get(node)?.[pos] ?? text.length;
    },
    point(pos) {
      const index = Math.max(0,Math.min(pos,text.length));
      const span = spans.find(s => index >= s.start && index <= s.start+s.length);
      if (span) return [span.node,index-span.start];
      for (const [node,bounds] of offsets) { const i = bounds.indexOf(index); if (i >= 0) return [node,i]; }
      return [root,root.childNodes.length];
    },
  };
}
function caret(root,edge) {
  const layout = draftLayout(root), s = getSelection();
  if (!s?.rangeCount) return layout.text.length;
  const r = s.getRangeAt(0);
  return layout.offset(r[edge+'Container'],r[edge+'Offset']);
}
