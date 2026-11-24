/* Shared conversation prose, independent of either transport or DOM shell. */
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[c]);
function safeHref(href) { return /^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(href); }
function emphasis(text) {
  return escape(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
const anchor = (href, html) => '<a href="' + escape(href) + '" target="_blank" rel="noopener noreferrer">' + html + '</a>';
function inline(text) {
  // Tokenize first: never run a text replacement across generated HTML/attributes.
  // A bare web address is a link too, as the terminal shows it; trailing punctuation is prose.
  let html = '', start = 0;
  for (const match of text.matchAll(/`([^`]+)`|\[([^\]\n]*)\]\(([^)\s]+)\)|<?(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*~])>?/g)) {
    html += emphasis(text.slice(start, match.index));
    if (match[1] !== undefined) html += '<code>' + escape(match[1]) + '</code>';
    else if (match[4] !== undefined) html += safeHref(match[4]) ? anchor(match[4], escape(match[4])) : escape(match[0]);
    else if (!safeHref(match[3])) html += escape(match[0]);
    else html += anchor(match[3], emphasis(match[2] || match[3]));
    start = match.index + match[0].length;
  }
  return html + emphasis(text.slice(start));
}
function codeBlock(code, lang) {
  return '<div class="code-block"><div class="code-head"><span class="code-lang">' + escape(lang || 'text') + '</span>' +
    '<button class="code-copy" type="button" data-copy-code aria-label="Copy code">⧉</button></div><pre><code>' + escape(code) + '</code></pre></div>';
}
export function renderMarkdown(text) {
  const lines = String(text ?? '').split('\n'), out = [];
  let paragraph = [], list = null;
  const flushParagraph = () => {
    if (paragraph.length) out.push('<p>' + inline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>');
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push('<' + list.tag + '>' + list.items.map(item => '<li>' + inline(item) + '</li>').join('') + '</' + list.tag + '>');
    list = null;
  };
  const flush = () => { flushParagraph(); flushList(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], fence = /^\s*```+\s*(\S+)?\s*$/.exec(line);
    if (fence) {
      flush(); const body = [];
      for (++i; i < lines.length && !/^\s*```+\s*$/.test(lines[i]); ++i) body.push(lines[i]);
      out.push(codeBlock(body.join('\n'), fence[1])); continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); const tag = 'h' + Math.min(6, heading[1].length + 1); out.push('<' + tag + '>' + inline(heading[2]) + '</' + tag + '>'); continue; }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { flush(); out.push('<hr>'); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flush(); out.push('<blockquote>' + inline(quote[1]) + '</blockquote>'); continue; }
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph(); const tag = /^\d/.test(bullet[1]) ? 'ol' : 'ul';
      if (list?.tag !== tag) { flushList(); list = {tag, items:[]}; }
      list.items.push(bullet[2]); continue;
    }
    if (line.includes('|') && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[i + 1] || '')) {
      flush(); const cells = row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => inline(cell.trim()));
      const row = (source, tag) => '<tr>' + cells(source).map(c => '<' + tag + '>' + c + '</' + tag + '>').join('') + '</tr>';
      out.push('<div class="table-wrap"><table><thead>' + row(line,'th') + '</thead><tbody>');
      for (i += 2; i < lines.length && lines[i].includes('|'); ++i) out.push(row(lines[i], 'td'));
      --i; out.push('</tbody></table></div>'); continue;
    }
    if (!line.trim()) flush(); else { flushList(); paragraph.push(line); }
  }
  flush(); return out.join('');
}
