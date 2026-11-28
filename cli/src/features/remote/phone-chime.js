// A short, audible two-note PCM WAV played through the browser's media player.
// A brief silent lead allows a gesture on a restored tab to prime the same
// element without sounding a completion that never happened.
export function chimeWave() {
  const rate = 16000, frames = Math.round(rate * 0.55);
  const bytes = new Uint8Array(44 + frames * 2), v = new DataView(bytes.buffer);
  const tag = (at, text) => bytes.set(new TextEncoder().encode(text), at);
  const u16 = (at, n) => v.setUint16(at,n,true), u32 = (at, n) => v.setUint32(at,n,true);
  tag(0,'RIFF'); u32(4,bytes.length - 8); tag(8,'WAVE'); tag(12,'fmt '); u32(16,16);
  u16(20,1); u16(22,1); u32(24,rate); u32(28,rate * 2); u16(32,2); u16(34,16);
  tag(36,'data'); u32(40,frames * 2);
  for (const [start,hz] of [[0.08,660],[0.27,880]]) {
    for (let i=0; i<rate*0.23; i++) {
      const t=i/rate, envelope=Math.min(1,t/0.012) * (1-t/0.23) ** 2;
      v.setInt16(44+2*(Math.round(start*rate)+i),Math.round(15000*envelope*Math.sin(2*Math.PI*hz*t)),true);
    }
  }
  return new Blob([bytes],{type:'audio/wav'});
}

export function mediaChime(window, blocked) {
  const url = window.URL.createObjectURL(chimeWave()), audio = new window.Audio(url);
  audio.preload = 'auto';
  let primed = false, priming = false, sequence = 0;
  async function play(previewOnly) {
    const id = ++sequence;
    priming = previewOnly;
    try {
      audio.currentTime = 0;
      await audio.play();
      if (sequence !== id) return;
      primed = true;
      if (previewOnly) { audio.pause(); audio.currentTime = 0; }
    } catch {
      if (sequence !== id) return;
      primed = false;
      if (!previewOnly) blocked();
    } finally { if (sequence === id) priming = false; }
  }
  return {
    unlock() { if (!primed && !priming && audio.paused) void play(true); },
    ring() { void play(false); },
    dispose() { sequence++; audio.pause(); audio.removeAttribute('src'); audio.load(); window.URL.revokeObjectURL(url); },
  };
}
