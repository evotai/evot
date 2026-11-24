import { renderMarkdown } from '../../../../src/app/assets/console/ui/chat-markdown.js';

// Reuse the actual DOM node across deltas, completion and bounded-history shifts:
// an expanded thinking block, text selection or focused button must not reset on poll.
function paintBlock(node, block, expanded) {
  if (block.kind === 'thinking') {
    if (node.source === block.text) return;
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
    node.source = block.text;
    node.firstChild.lastChild.textContent = block.text
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .slice(-2)
      .join('\n')
      .slice(-220);
    node.lastChild.textContent = block.text;
  } else if (block.kind === 'tool') {
    // The Mac sends exactly the current compact/expanded tool card. Do not
    // parse tool names, exit codes or lifecycle states again in the browser.
    if (!node.firstChild) {
      node.className = 'tool-activity';
      const rail = document.createElement('span'), toggle = document.createElement('button');
      rail.className = 'tool-rail'; rail.tabIndex = 0;
      toggle.type = 'button'; toggle.className = 'tool-details'; toggle.textContent = '···';
      node.append(rail, toggle);
    }
    const rail = node.firstChild, toggle = node.lastChild;
    node.dataset.state = block.state;
    const label = expanded ? 'Collapse tool details on Mac' : 'Expand tool details on Mac';
    toggle.ariaLabel = toggle.title = label;
    toggle.setAttribute('aria-pressed', String(expanded));
    if (node.source !== block.text || node.expanded !== expanded) {
      const lines = block.text.trim().split(/\r?\n/);
      const text = expanded ? lines.map(line => line.trim()).filter(Boolean).join('  ·  ') : lines[0];
      if (rail.textContent !== text) rail.textContent = text;
      node.source = block.text; node.expanded = expanded;
    }
    rail.title = `Tool · ${block.state}. Scroll sideways for more.`;
  } else {
    if (node.source === block.text) return;
    const offsets = Array.from(node.querySelectorAll('.table-wrap'), (el) => el.scrollLeft);
    node.source = block.text;
    node.className = 'text-content';
    node.innerHTML = renderMarkdown(block.text);
    node.querySelectorAll('.table-wrap').forEach((el, i) => {
      if (offsets[i]) el.scrollLeft = offsets[i];
    });
  }
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
