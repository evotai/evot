import { SPINNER_INTERVAL_MS } from '../../ui/activity-frames.js';

// Replace only the glyph, as the TUI does. No CSS motion or server ticks.
export function registerActivityMarks(document, frames) {
  const window = document.defaultView, running = new Set(), visible = new Set();
  let clock;
  function sync() {
    const active = [...running].some(mark => visible.has(mark));
    if (document.hidden || !active) {
      window.clearInterval(clock);
      clock = undefined;
    } else if (clock === undefined) {
      let index = 0;
      clock = window.setInterval(() => {
        index = (index + 1) % frames.length;
        const frame = frames[index];
        for (const mark of running) if (visible.has(mark) && mark.textContent !== frame) mark.textContent = frame;
      }, SPINNER_INTERVAL_MS);
    }
  }
  const observer = new window.IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      if (isIntersecting && target.isConnected) visible.add(target);
      else visible.delete(target);
    }
    sync();
  });
  window.customElements.define('evot-activity', class extends window.HTMLElement {
    static observedAttributes = ['data-running'];
    connectedCallback() {
      if (!this.textContent) this.textContent = frames[0];
      observer.observe(this);
      this.attributeChangedCallback();
    }
    disconnectedCallback() {
      observer.unobserve(this);
      visible.delete(this);
      running.delete(this);
      sync();
    }
    attributeChangedCallback() {
      if (!this.isConnected) return;
      if (this.hasAttribute('data-running')) {
        if (!running.has(this)) this.textContent = frames[0];
        running.add(this);
      } else {
        running.delete(this);
        this.textContent = '·';
      }
      sync();
    }
  });
  document.addEventListener('visibilitychange', sync);
}
