const CHECK_MS = 2000;
const prefix = 'evot.remote.sound.v1:';
const keyOf = target => target?.session ? `session:${target.session}` : target?.terminal ? `window:${target.terminal}` : null;

// Compare rounds from the same live window AND conversation. Opening another
// conversation in a window isn't a completion, even if its counter is higher.
export function roundCompletions(previous, rows) {
  const seen = new Map();
  let finished = false;
  for (const {terminal, session, finishedRound} of rows) {
    if (finishedRound !== null && !Number.isSafeInteger(finishedRound)) continue;
    const id = JSON.stringify([terminal,session ?? null]);
    if (finishedRound !== null && previous.has(id) && finishedRound > (previous.get(id) ?? -1)) finished = true;
    seen.set(id, finishedRound);
  }
  return {seen, finished};
}

function chime(context) {
  if (context?.state !== 'running') return;
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
  const enabled = new Set();
  let context, timer, watcher = null, paired = false, target = null;
  try {
    const store = window.localStorage;
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(prefix) && store.getItem(k) === '1') enabled.add(k.slice(prefix.length));
    }
  } catch { /* Without site data, the in-memory switch still works. */ }
  function remember(key, yes) {
    if (yes) enabled.add(key); else enabled.delete(key);
    try {
      if (yes) window.localStorage.setItem(prefix + key,'1'); else window.localStorage.removeItem(prefix + key);
    } catch { /* Private/disabled storage. */ }
  }
  function bind(row) {
    const temporary = `window:${row.terminal}`;
    if (row.session && enabled.has(temporary)) {
      remember(keyOf(row),true); remember(temporary,false);
    }
  }
  function unlock() {
    if (!watcher || context?.state === 'running') return;
    // Restoring the preference isn't itself a user gesture. Retry on the next
    // interaction if the browser suspends audio; never erase the preference.
    try { context ??= new AudioContext(); if (context.state !== 'running') void context.resume().catch(() => {}); } catch { /* unavailable until a gesture */ }
  }
  async function check(current) {
    if (watcher !== current || document.hidden || current.checking) return;
    current.checking = true;
    try {
      const {online} = await inventory();
      if (watcher !== current || document.hidden) return;
      const {seen, finished} = roundCompletions(current.seen, online.filter(row => enabled.has(keyOf(row))));
      current.seen = seen;
      if (finished) chime(context);
    } catch { current.seen.clear(); /* Reconnect with a fresh baseline, not a backlog of chimes. */ }
    finally {
      current.checking = false;
      if (watcher === current && !document.hidden) timer = window.setTimeout(() => check(current), CHECK_MS);
    }
  }
  function sync() {
    button.hidden = !paired || !target || !AudioContext;
    button.setAttribute('aria-pressed',String(!button.hidden && enabled.has(keyOf(target))));
    if (!paired || !enabled.size || !AudioContext) {
      watcher = null; window.clearTimeout(timer);
    } else if (!watcher) {
      watcher = {seen:new Map(),checking:false}; unlock(); void check(watcher);
    }
  }
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(timer);
    if (watcher) { watcher.seen.clear(); void check(watcher); }
  });
  document.addEventListener('click',unlock,true);
  document.addEventListener('keydown',unlock,true);
  window.addEventListener('storage', e => {
    if (e.key === null) enabled.clear();
    else if (e.key.startsWith(prefix)) {
      const k = e.key.slice(prefix.length); if (e.newValue === '1') enabled.add(k); else enabled.delete(k);
    } else return;
    sync();
  });
  button.onclick = () => {
    if (button.hidden) return;
    const key = keyOf(target), yes = !enabled.has(key);
    remember(key,yes); sync();
    notice(yes ? 'Round-end sound on for this session.' : 'Round-end sound off for this session.');
  };
  return { setPaired(yes) { paired = yes; sync(); }, select(next) {
    target = next;
    if (next) bind(next);
    sync();
  } };
}
