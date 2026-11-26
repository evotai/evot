// Like the TUI, pending prompts live above the input, outside conversation history.
// The host supplies order/state only. Previews and pullback data belong to this page.
export const pendingDrafts = s => s?.pendingDrafts ?? s?.pendingSteers;

export const lastDraft = s => s?.promptQueue ? s.promptQueue.at(-1)?.draftId : pendingDrafts(s)?.at(-1);

export function queueRows(s, outbox) {
  const queued = outbox.filter(item => item.kind !== 'send');
  const local = new Map(queued.filter(item => item.draftId).map(item => [item.draftId,item]));
  const stateFor = item => item.kind === 'queue' ? 'after' : 'now';
  const rows = (s?.promptQueue ?? (pendingDrafts(s) ?? []).map(draftId => ({draftId,
    state: local.has(draftId) ? stateFor(local.get(draftId)) : s.pendingSteers?.includes(draftId) ? 'now' : 'after'})))
    .map(({state,draftId}) => ({state, item:local.get(draftId)}));
  const represented = new Set(rows.map(r => r.item));
  for (const item of queued) if (!represented.has(item) && (item.sending || !pendingDrafts(s) && !s?.promptQueue))
    rows.push({state:item.sending ? 'sending' : stateFor(item), item});
  return rows;
}

export function queueStrip(root, thumbnail) {
  let painted = '';
  return function render(s, outbox) {
    const rows = queueRows(s,outbox), visible = rows.slice(0,3);
    const key = JSON.stringify([rows.length,visible.map(({state,item}) => [state,item?.draftId,item?.text,item?.previews.map(p => p.url)])]);
    if (key === painted) return rows.length;
    painted = key; root.hidden = !rows.length;
    root.replaceChildren(...visible.map(({state,item},i) => {
      const row = document.createElement('div'), label = document.createElement('span');
      label.textContent = `#${i+1} [${state}] ${(item?.text || 'Pending message').replace(/\s+/g,' ').trim()}`;
      row.append(label); if (item?.previews.length) row.append(...item.previews.map(thumbnail));
      return row;
    }));
    if (rows.length > visible.length) {
      const more = document.createElement('small'); more.textContent = `↓ ${rows.length-visible.length} more queued`; root.append(more);
    }
    return rows.length;
  };
}
