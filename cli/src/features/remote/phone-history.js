// A window from before the computer sent rendered Markdown: show its text as written.
function plainHtml(text) {
  const esc = String(text ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  return esc.split(/\n{2,}/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
}

// Reuse the actual DOM node across deltas, completion and bounded-history shifts:
// an expanded thinking block, text selection or focused button must not reset on poll.
function paintBlock(node, block, expanded) {
  if (block.kind === 'thinking') {
    if (node.source === (block.html ?? block.text)) return;
    if (!node.firstChild) {
      node.className = 'reason-card';
      const summary = document.createElement('summary'),
        preview = document.createElement('span'),
        text = document.createElement('div');
      summary.append('Thinking', preview);
      preview.className = 'reason-tail';
      text.className = 'reason-full';
      node.append(summary, text);
    }
    node.source = block.html ?? block.text;
    // The folded preview is the last lines as read, without Markdown marks.
    let readable = block.text;
    if (block.html) { const scratch = document.createElement('div'); scratch.innerHTML = block.html.replace(/<\/(p|li|h\d|div|pre|tr)>/g, '$&\n'); readable = scratch.textContent; }
    node.firstChild.lastChild.textContent = readable
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .slice(-2)
      .join('\n')
      .slice(-220);
    if (block.html) { node.lastChild.innerHTML = block.html; node.lastChild.classList.add('text-content'); }
    else node.lastChild.textContent = block.text;
  } else if (block.kind === 'tool') {
    // The TUI sends exactly the current compact/expanded tool card. Do not
    // parse tool names, exit codes or lifecycle states again in the browser.
    paintDiff(node, block.diff);
    if (!node.querySelector('.tool-rail')) {
      node.className = 'tool-activity';
      const rail = document.createElement('div'), toggle = document.createElement('button');
      rail.className = 'tool-rail'; rail.tabIndex = 0;
      toggle.type = 'button'; toggle.className = 'tool-details'; toggle.textContent = '···';
      node.prepend(rail, toggle);
    }
    const rail = node.querySelector('.tool-rail'), toggle = node.querySelector('.tool-details');
    node.dataset.state = block.state;
    const label = expanded ? 'Collapse tool details' : 'Expand tool details';
    toggle.ariaLabel = toggle.title = label;
    toggle.setAttribute('aria-pressed', String(expanded));
    if (node.source !== block.text || node.expanded !== expanded) {
      paintCard(rail, block.text);
      node.source = block.text; node.expanded = expanded;
    }
    rail.title = `Tool · ${block.state}. Scroll sideways for long lines.`;
  } else {
    if (node.source === (block.html ?? block.text)) return;
    const offsets = Array.from(node.querySelectorAll('.table-wrap'), (el) => el.scrollLeft);
    node.source = block.html ?? block.text;
    node.className = 'text-content';
    // The computer sends the TUI's own Markdown layout; a window too old to send it shows plain text.
    node.innerHTML = block.html ?? plainHtml(block.text);
    node.querySelectorAll('.table-wrap').forEach((el, i) => {
      if (offsets[i]) el.scrollLeft = offsets[i];
    });
  }
}
// A tool card row for row as the TUI draws it: headline, status, body. Lines never
// wrap; the card scrolls sideways. The ··· button stands in for the TUI's ctrl+o, so
// its key hints are dropped. Only the status mark takes the card's state colour.
function paintCard(rail, text) {
  const rows = text.replace(/\s*\(ctrl\+o[^)]*\)/g, '').split(/\r?\n/).filter((row, i) => i === 0 || row.trim());
  const lines = document.createElement('div');
  lines.className = 'card-lines';
  rows.forEach((row, i) => {
    const line = document.createElement('div');
    line.className = i === 0 ? 'card-row card-head' : 'card-row';
    const mark = i > 0 && /^(\s*)([✓✗●○])(.*)$/.exec(row);
    if (mark) {
      const glyph = document.createElement('span'); glyph.className = 'card-mark'; glyph.textContent = mark[2];
      line.append(mark[1], glyph, mark[3]);
    } else line.textContent = row || ' ';
    lines.append(line);
  });
  rail.replaceChildren(lines);
}
// A Write/Edit patch as the TUI lays it out on a narrow pane: recessed line
// numbers, row tint for added/removed lines, a stronger fill on changed words.
// Long lines wrap beside the gutter, never under it.
function paintDiff(node, rows) {
  const key = rows ? JSON.stringify(rows) : '';
  if (node.diffKey === key) return;
  node.diffKey = key;
  node.querySelector('.tool-diff')?.remove();
  if (!rows?.length) return;
  const box = document.createElement('div'), lines = document.createElement('div');
  box.className = 'tool-diff'; box.tabIndex = 0; box.setAttribute('aria-label', 'Patch. Scroll sideways for long lines.');
  lines.className = 'diff-lines'; box.append(lines);
  box.addEventListener('scroll', () => box.toggleAttribute('data-scrolled', box.scrollLeft > 0), { passive: true });
  for (const row of rows) {
    const line = document.createElement('div'), num = document.createElement('span'), code = document.createElement('span');
    line.className = 'diff-row'; line.dataset.kind = row.kind;
    num.className = 'diff-num'; num.textContent = row.num ?? '';
    code.className = 'diff-code';
    for (const seg of row.code) {
      if (seg.word) { const mark = document.createElement('mark'); mark.textContent = seg.text; code.append(mark); }
      else code.append(seg.text);
    }
    line.append(num, code);
    lines.append(line);
  }
  node.append(box);
}
export function renderHistory(root, s) {
  const rows = [...s.messages];
  if (s.live || s.liveBlocks?.length) rows.push({ role: 'assistant', text: s.live, blocks: s.liveBlocks });
  const first = s.messageOffset ?? 0;
  while (root.firstChild && Number(root.firstChild.dataset.index) < first) root.firstChild.remove();
  while (root.childElementCount > rows.length) root.lastElementChild.remove();
  rows.forEach((m, i) => {
    const el = root.children[i] || root.appendChild(document.createElement('article'));
    if (el.dataset.index !== String(first + i) || el.dataset.role !== m.role) {
      el.replaceChildren();
      el.source = null;
      el.dataset.index = first + i;
      el.dataset.role = m.role;
      el.className = 'message message-' + m.role;
    }
    if (m.role !== 'assistant') {
      if (el.source === m.text) return;
      const body = document.createElement('div');
      body.className = m.role === 'user' ? 'bubble' : m.role === 'notice' ? 'terminal-notice' : 'turn-footer';
      body.textContent = el.source = m.text;
      el.replaceChildren(body);
      return;
    }
    const blocks = m.blocks ?? [{ kind: 'text', text: m.text }];
    while (el.childElementCount > blocks.length) el.lastElementChild.remove();
    blocks.forEach((b, j) => {
      let node = el.children[j];
      if (node?.dataset.kind !== b.kind) {
        const next = document.createElement(b.kind === 'thinking' ? 'details' : 'div');
        next.dataset.kind = b.kind;
        if (node) node.replaceWith(next);
        else el.append(next);
        node = next;
      }
      paintBlock(node, b, !!s.expanded);
    });
  });
  return rows.length;
}
