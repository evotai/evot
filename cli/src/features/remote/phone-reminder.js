import { mediaChime } from './phone-chime.js';

const CHECK_MS = 2000, BACKGROUND_CHECK_MS = 10000;
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

export function completionReminder(button, inventory, notice) {
  const document = button.ownerDocument, window = document.defaultView;
  const supported = !!window.Audio && !!window.URL?.createObjectURL;
  const enabled = new Set();
  let player, timer, watcher = null, paired = false, target = null;
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
  // Safari's ambient audio can follow the ringer switch. An explicitly enabled
  // bell is media playback; the system still controls volume and suspension.
  let previousAudioType;
  function playbackMode(enable) {
    try {
      const session = window.navigator?.audioSession;
      if (!session) return;
      if (enable && previousAudioType === undefined && session.type !== 'playback') {
        const previous = session.type;
        session.type = 'playback'; previousAudioType = previous;
      } else if (!enable && previousAudioType !== undefined) {
        if (session.type === 'playback') session.type = previousAudioType;
        previousAudioType = undefined;
      }
    } catch { /* Older WebKit: still use media element playback. */ }
  }
  function unlock(event) {
    if (watcher && event.target !== button && !button.contains(event.target)) player.unlock();
  }
  // The open chat already receives its host's completion in the state stream.
  // Do not wait for (or replay it from) the separate all-window inventory.
  function observe(terminal, {sessionId:session, finishedRound}) {
    if (!watcher || !enabled.has(keyOf({terminal, session})) ||
        (finishedRound !== null && !Number.isSafeInteger(finishedRound))) return;
    const id = JSON.stringify([terminal, session ?? null]);
    watcher.live = id;
    const previous = watcher.seen.get(id);
    watcher.seen.set(id, finishedRound);
    if (previous !== undefined && finishedRound !== null && finishedRound > (previous ?? -1)) player.ring();
  }
  async function check(current) {
    if (watcher !== current || current.checking) return;
    current.checking = true;
    try {
      const {online} = await inventory();
      if (watcher !== current) return;
      const {seen, finished} = roundCompletions(current.seen, online.filter(row => enabled.has(keyOf(row)) &&
        (document.hidden || JSON.stringify([row.terminal,row.session ?? null]) !== current.live)));
      if (!seen.has(current.live) && current.seen.has(current.live)) seen.set(current.live,current.seen.get(current.live));
      current.seen = seen;
      if (finished) player.ring();
    } catch {
      for (const id of current.seen.keys()) if (id !== current.live) current.seen.delete(id);
    }
    finally {
      current.checking = false;
      if (watcher === current) timer = window.setTimeout(() => check(current), document.hidden ? BACKGROUND_CHECK_MS : CHECK_MS);
    }
  }
  function sync() {
    if (watcher && watcher.live && !enabled.has(keyOf(target))) {
      watcher.seen.delete(watcher.live); watcher.live = null;
    }
    button.hidden = !paired || !target || !supported;
    button.setAttribute('aria-pressed',String(!button.hidden && enabled.has(keyOf(target))));
    if (!paired || !enabled.size || !supported) {
      watcher = null; window.clearTimeout(timer); player?.dispose(); player = null; playbackMode(false);
    } else if (!watcher) {
      playbackMode(true);
      player = mediaChime(window, () => notice('Sound could not play. Tap the page to enable audio.'));
      watcher = {seen:new Map(),checking:false}; void check(watcher);
    }
  }
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(timer);
    // The chat stream pauses when hidden. Let inventory cover it for as long as
    // the browser runs this tab. Refetch when visible without losing the baseline.
    if (watcher) { watcher.live = null; void check(watcher); }
  });
  document.addEventListener('touchend',unlock,{capture:true,passive:true});
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
    if (yes) player.ring(); // Audible check inside this tap, using the exact completion sound.
    notice(yes ? 'Round-end sound on for this session.' : 'Round-end sound off for this session.');
  };
  return { observe, setPaired(yes) { paired = yes; sync(); }, select(next) {
    if (watcher && (target?.terminal !== next?.terminal || target?.session !== next?.session)) watcher.live = null;
    target = next;
    if (next) bind(next);
    sync();
  } };
}
