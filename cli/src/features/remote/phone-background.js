// The phone only chooses which TUI view to inspect. The owning terminal
// resolves the task, formats status/output and restricts it to its session.
export function backgroundPanel(document, refresh) {
  const el = (id) => document.getElementById(id),
    panel = el('bgPanel'), chip = el('bgChip'), countLabel = el('bgCount'),
    output = el('bgOutput');
  let selected = null,
    tasks = [];
  function select(id) {
    selected = id;
    if (!panel.open) panel.showModal();
    void refresh();
  }
  chip.onclick = () => { if (tasks.length) select(tasks.length === 1 ? tasks[0].id : 'list'); };
  el('allTasks').onclick = () => select('list');
  el('closeBg').onclick = () => panel.close();
  panel.onclose = () => {
    selected = null;
    output.textContent = '';
  };
  function render(bg) {
    tasks = bg?.tasks ?? [];
    const count = tasks.length;
    chip.hidden = !count;
    const label = count ? `${count} ${count === 1 ? 'task' : 'tasks'} running` : '';
    if (countLabel.textContent !== label) {
      countLabel.textContent = label;
      chip.ariaLabel = label ? `Background: ${label}` : '';
    }
    if (!count) {
      selected = null;
      if (panel.open) panel.close();
      return;
    }
    if (!selected) return;
    const task = tasks.find((t) => t.id === selected);
    if (!task) selected = 'list';
    const data = task && bg.output?.id === task.id ? bg.output : null;
    el('bgTitle').textContent = data ? 'Background output' : 'Background';
    el('bgOutputActivity').hidden = !data;
    el('bgSubtitle').textContent = data ? [task.title, task.status].filter(Boolean).join(' · ') : bg.subtitle ?? '';
    el('allTasks').hidden = !data || tasks.length < 2;
    output.hidden = !data;
    el('bgTasks').hidden = !!data;
    if (data) {
      const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 32;
      if (output.textContent !== data.text) output.textContent = data.text;
      if (follow) output.scrollTop = output.scrollHeight;
    } else {
      const list = el('bgTasks'),
        keep = new Set();
      for (const task of tasks) {
        let button = Array.from(list.children).find((b) => b.dataset.id === task.id);
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.dataset.id = task.id;
          button.onclick = () => select(task.id);
          const glyph = document.createElement('span');
          glyph.className = 'activity-mark';
          glyph.setAttribute('aria-hidden', 'true');
          button.append(document.createElement('strong'), glyph, document.createElement('small'));
          list.append(button);
        }
        keep.add(button);
        const title = task.title || 'Background task';
        const meta = [task.status, task.activity, task.detail].filter(Boolean).join(' · ');
        if (button.firstChild.textContent !== title) button.firstChild.textContent = title;
        if (button.lastChild.textContent !== meta) button.lastChild.textContent = meta;
      }
      for (const b of Array.from(list.children)) if (!keep.has(b)) b.remove();
    }
  }
  return {
    render,
    get selected() {
      return panel.open ? selected : null;
    },
  };
}
