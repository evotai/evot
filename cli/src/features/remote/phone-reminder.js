const CHECK_MS = 2000;

// Only compare live windows already seen since enabling sound. An old result,
// a vanished window, or a task status change is not a round completion.
export function roundCompletions(previous, rows) {
  const seen = new Map();
  let finished = false;
  for (const {terminal, finishedRound} of rows) {
    if (finishedRound !== null && !Number.isSafeInteger(finishedRound)) continue;
    if (finishedRound !== null && previous.has(terminal) && finishedRound > (previous.get(terminal) ?? -1)) finished = true;
    seen.set(terminal, finishedRound);
  }
  return {seen, finished};
}

function chime(context) {
  if (context.state !== 'running') return;
  const start = context.currentTime;
  for (const [frequency, offset] of [[660, 0], [880, 0.12]]) {
    const time = start + offset;
    const tone = context.createOscillator(), envelope = context.createGain();
    tone.frequency.value = frequency;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(0.1, time + 0.015);
    envelope.gain.linearRampToValueAtTime(0, time + 0.16);
    tone.connect(envelope).connect(context.destination);
    tone.start(time);
    tone.stop(time + 0.16);
    tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
  }
}

export function completionReminder(button, inventory, notice) {
  const document = button.ownerDocument, window = document.defaultView;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  let context, timer, watcher = null;

  function stop() {
    watcher = null;
    window.clearTimeout(timer);
    button.setAttribute('aria-pressed', 'false');
  }
  async function check(current) {
    if (watcher !== current || document.hidden || current.checking) return;
    current.checking = true;
    try {
      const {online} = await inventory();
      if (watcher !== current || document.hidden) return;
      const {seen, finished} = roundCompletions(current.seen, online);
      current.seen = seen;
      if (finished) chime(context);
    } catch { /* A transient read failure is not a completion. */ }
    finally {
      current.checking = false;
      if (watcher === current && !document.hidden) timer = window.setTimeout(() => check(current), CHECK_MS);
    }
  }
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(timer);
    if (watcher) void check(watcher);
  });
  button.onclick = () => {
    if (watcher) {
      stop();
      notice('Round-end sound off.');
      return;
    }
    if (button.hidden) return;
    const current = watcher = { seen:new Map(), checking:false };
    const blocked = () => {
      if (watcher !== current) return;
      stop();
      notice('This browser couldn’t enable sound.');
    };
    try {
      // Mobile browsers require audio to be unlocked in a user gesture.
      context ??= new AudioContext();
      void context.resume().catch(blocked);
      button.setAttribute('aria-pressed', 'true');
      notice('Round-end sound on.');
      void check(current);
    } catch { blocked(); }
  };
  return { setPaired(yes) {
    button.hidden = !yes || !AudioContext;
    if (!yes) stop();
  } };
}
