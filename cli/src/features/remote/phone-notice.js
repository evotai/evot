import { noticeHref, noticeResult } from '../../ui/notice-layout.js';

/** Hosts predating spans only sent text, an optional glyph flag and a URL. */
function legacySpans(text, {styled, link}) {
  const mark = styled && /^(\s*)([⋯✓✗]) /.exec(text);
  if (!mark) return link ? noticeResult(text, link) : [{text, tone:'muted'}];
  const tone = mark[2] === '✗' ? 'error' : mark[2] === '✓' ? 'success' : 'muted';
  const body = text.slice(mark[0].length);
  const rest = link ? noticeResult(body, link) : [{text:body, tone:tone === 'error' ? 'body' : 'muted'}];
  return [{text:mark[1]}, {text:mark[2], tone}, {text:' '}, ...rest];
}

/** Browser adapter for the same spans the TUI paints in ANSI. Text stays text. */
export function paintCommandNotice(root, text, command) {
  const doc = root.ownerDocument;
  root.classList.add('command-notice');
  for (const span of command.spans ?? legacySpans(text, command)) {
    if (!span.text) continue;
    const href = span.link && noticeHref(span.text);
    if (!href && !span.tone) { root.append(span.text); continue; }
    const node = doc.createElement(href ? 'a' : 'span');
    node.textContent = span.text;
    if (href) { node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    if (span.tone) node.dataset.tone = span.tone;
    root.append(node);
  }
}
