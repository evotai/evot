// The phone only chooses which TUI view to inspect. The owning terminal
// resolves the task, formats status/output and restricts it to its session.
export function backgroundPanel(refresh) {
  const el = (id) => document.getElementById(id),
    panel = el('bgPanel'),
    chip = el('bgChip'),
    output = el('bgOutput');
  let selected = null,
    tasks = [];
  function select(id) {
    selected = id;
    if (!panel.open) panel.showModal();
    void refresh();
  }
  chip.onclick = () => select(tasks.length === 1 ? tasks[0].id : 'list');
  el('allTasks').onclick = () => select('list');
  el('closeBg').onclick = () => panel.close();
  panel.onclose = () => {
    selected = null;
    output.textContent = '';
  };
  function render(bg) {
    tasks = bg?.tasks ?? [];
    chip.hidden = !tasks.length;
    chip.textContent = bg?.chip || bg?.subtitle || '';
    if (!tasks.length || !selected) {
      if (!tasks.length && panel.open) panel.close();
      return;
    }
    if (selected !== 'list' && !tasks.some((t) => t.id === selected)) selected = 'list';
    const data = bg.output?.id === selected ? bg.output : null;
    el('bgTitle').textContent = data ? 'Background output' : 'Background';
    el('bgSubtitle').textContent = data ? data.id.slice(0, 8) : bg.subtitle;
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
          button.append(document.createElement('strong'), document.createElement('small'));
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
