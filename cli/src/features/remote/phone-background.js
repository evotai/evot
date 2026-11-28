// The phone only chooses which TUI view to inspect. The owning terminal
// resolves the task, formats status/output and restricts it to its session.
export function backgroundPanel(document, refresh) {
  const el = (id) => document.getElementById(id),
    panel = el('bgPanel'), statusButton = el('bgStatus'),
    output = el('bgOutput'), subtitle = el('bgSubtitle'), outputActivity = el('bgOutputActivity'),
    list = el('bgTasks'), allTasks = el('allTasks');
  let selected = null, background = null, connected = false, loading = false, shownTask = null;
  function setConnected(yes) {
    if (connected === yes) return;
    connected = yes;
    outputActivity.toggleAttribute('data-running', yes);
    for (const mark of list.querySelectorAll('evot-activity')) mark.toggleAttribute('data-running', yes);
    if (panel.open && loading) paint();
  }
  function select(id) {
    selected = id;
    loading = true;
    paint();
    if (!panel.open) panel.showModal();
    void refresh();
  }
  statusButton.onclick = () => {
    const tasks = background?.tasks;
    if (tasks?.length) select(tasks.length === 1 ? tasks[0].id : 'list');
  };
  allTasks.onclick = () => select('list');
  el('closeBg').onclick = () => panel.close();
  panel.onclose = () => {
    if (panel.open || !selected) return;
    clearSelection();
    void refresh(); // Stop the old stream from reading task output after dismissal.
  };
  function clearSelection() {
    selected = shownTask = null;
    loading = false;
    output.textContent = '';
  }
  function render(bg) {
    background = bg;
    loading = false;
    const count = bg?.tasks.length ?? 0;
    statusButton.hidden = !count;
    const label = count ? `${count} ${count === 1 ? 'task' : 'tasks'}` : '';
    if (statusButton.textContent !== label) {
      statusButton.textContent = label;
      statusButton.ariaLabel = count ? `Open background tasks: ${label} running` : '';
    }
    if (!count) {
      clearSelection();
      if (panel.open) panel.close();
    } else if (panel.open) paint();
  }
  function paint() {
    const tasks = background.tasks;
    const task = tasks.find(t => t.id === selected);
    if (!task) selected = 'list';
    const data = task && !loading && background.output?.id === task.id ? background.output : null;
    el('bgTitle').textContent = task ? 'Background output' : 'Background';
    outputActivity.hidden = !task;
    const description = task ? [task.title, task.status].filter(Boolean).join(' · ') : background.subtitle ?? '';
    if (subtitle.textContent !== description) subtitle.textContent = description;
    allTasks.hidden = !task || tasks.length < 2;
    output.hidden = !task;
    list.hidden = !!task;
    if (task) {
      const follow = shownTask !== task.id || output.scrollHeight - output.scrollTop - output.clientHeight < 32;
      shownTask = task.id;
      const text = data?.text ?? (loading ? connected ? 'Loading task output…' : 'Reconnecting to load task output…' : 'No task output available yet.');
      if (output.textContent !== text) output.textContent = text;
      if (follow) output.scrollTop = output.scrollHeight;
    } else {
      shownTask = null;
      const keep = new Set();
      for (const task of tasks) {
        let button = Array.from(list.children).find((b) => b.dataset.id === task.id);
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.dataset.id = task.id;
          button.onclick = () => select(task.id);
          const glyph = document.createElement('evot-activity');
          glyph.toggleAttribute('data-running', connected);
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
    render, setConnected,
    get selected() {
      return panel.open ? selected : null;
    },
  };
}
