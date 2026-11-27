// Delivery is not execution. Bridge an idle send to the first authoritative
// run snapshot without changing the generation, input mode or stop controls.
export function turnStartFeedback(changed, clock = globalThis) {
  let current = null, timer;
  function clear() {
    clock.clearTimeout(timer);
    if (!current) return;
    current = null; changed();
  }
  return {
    get label() { return current?.label; },
    begin(view, hasPhotos) {
      clear();
      const turn = current = { generation:view.generation, label:hasPhotos ? 'Uploading…' : 'Sending…' };
      changed();
      return {
        accepted() {
          if (current !== turn) return;
          turn.label = 'Waiting for the computer to start…'; changed();
          // Older peers may never publish a run (e.g. local validation).
          timer = clock.setTimeout(clear, 15000);
        },
        failed() { if (current === turn) clear(); },
      };
    },
    observe(view) {
      if (current && (view.active || view.ask || view.generation !== current.generation)) clear();
    },
    clear,
  };
}
