// Sending and reading history give space back to the transcript. Latest,
// momentum, and run updates never reopen the composer.
const FOLD_DISTANCE = 72;
const REVEAL_DISTANCE = 32;
const LATEST_DISTANCE = 16;

export function conversationScroll({ chat, seat, editor, dock, write, jump, draft }) {
  let following = true, showLatest = false, compact = false, canCompact = false, shownCompact = false;
  let lastTop = 0, backFrom = 0, lastHeight = 0, touchStart = null, touchScroll = false;
  const { ownerDocument } = chat, window = ownerDocument.defaultView;
  let jumpFrame = null;
  // Safari can report negative or past-bottom positions during rubber-banding.
  const bottom = () => Math.max(0, chat.scrollHeight - chat.clientHeight);
  const scrollTop = () => Math.max(0, Math.min(chat.scrollTop, bottom()));
  const rememberPosition = () => { lastHeight = chat.clientHeight; backFrom = lastTop = scrollTop(); };
  function layout() {
    const folded = compact && canCompact;
    const hideJump = !showLatest || jumpFrame !== null;
    const focused = ownerDocument.activeElement;
    if ((hideJump && focused === jump) || (!folded && dock.contains(focused)) || (folded && editor.contains(focused))) {
      chat.focus({preventScroll:true});
    }
    dock.inert = !folded;
    jump.hidden = hideJump;
    editor.inert = folded;
    if (shownCompact !== folded) {
      shownCompact = folded;
      seat.toggleAttribute('data-reading', folded);
      rememberPosition();
    }
  }
  function keepLatest() {
    if (!following) return;
    chat.scrollTop = bottom();
    rememberPosition();
  }
  function stopJump() {
    if (jumpFrame === null) return;
    window.cancelAnimationFrame(jumpFrame);
    jumpFrame = null;
    rememberPosition();
    layout();
  }
  function followBottom() {
    following = true;
    showLatest = false;
    layout();
    keepLatest();
  }
  function latest() {
    stopJump();
    compact = false;
    followBottom();
  }
  function submitted({followLatest}) {
    if (followLatest) {
      stopJump();
      compact = true;
      followBottom();
    } else {
      fold();
      keepLatest();
    }
  }
  function openComposer() {
    compact = false;
    layout();
    keepLatest();
  }
  function scrollToLatest() {
    const top = scrollTop();
    if (bottom() - top <= 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      followBottom();
      return;
    }
    const start = window.performance.now();
    following = false;
    const step = now => {
      const progress = Math.max(0, (now - start) / 300);
      if (progress >= 1) { jumpFrame = null; followBottom(); return; }
      chat.scrollTop = top + (bottom() - top) * (1 - (1 - progress) ** 3);
      jumpFrame = window.requestAnimationFrame(step);
    };
    jumpFrame = window.requestAnimationFrame(step);
    layout();
  }
  function fold() {
    if (!canCompact || compact) return;
    showLatest ||= !following;
    compact = true;
    layout();
  }
  chat.addEventListener('scroll', () => {
    if (!chat.clientHeight || jumpFrame !== null) return;
    if (chat.clientHeight !== lastHeight) { rememberPosition(); return; }
    const top = scrollTop(), previous = lastTop, gap = bottom() - top;
    lastTop = top;
    if (top > previous) {
      backFrom = top;
      if (!following && gap <= LATEST_DISTANCE) followBottom();
    } else if (top < previous) {
      if (gap <= 1) { backFrom = top; return; } // Layout can clamp to an earlier bottom.
      following = false;
      if (gap >= FOLD_DISTANCE) showLatest = true;
      if (!touchScroll && backFrom - top >= FOLD_DISTANCE) fold();
    }
    layout();
  }, {passive:true});
  new window.ResizeObserver(() => {
    if (following) keepLatest();
    else if (chat.clientHeight !== lastHeight || scrollTop() !== lastTop) rememberPosition();
  }).observe(chat);

  // Leave scrolling to the browser. Measure the actual finger travel so a
  // scroll that merely arrives at the bottom (or coasts there) stays folded.
  chat.addEventListener('touchstart', event => {
    stopJump();
    touchScroll = true;
    const rail = event.target?.closest('.tool-rail');
    const nestedScroll = rail && rail.scrollHeight > rail.clientHeight;
    const top = scrollTop();
    touchStart = event.touches.length === 1 && !nestedScroll
      ? {touch:event.touches[0], top, gap:bottom() - top, folded:shownCompact}
      : null;
  }, {passive:true});
  chat.addEventListener('touchend', event => {
    const start = touchStart;
    touchStart = null;
    const end = start && Array.from(event.changedTouches).find(touch => touch.identifier === start.touch.identifier);
    if (!end) return;
    const down = end.clientY - start.touch.clientY, top = scrollTop(), gap = bottom() - top;
    if (Math.abs(down) <= Math.abs(end.clientX - start.touch.clientX)) return;
    if (start.folded && shownCompact && gap <= LATEST_DISTANCE && -down >= start.gap + REVEAL_DISTANCE) {
      compact = false;
      followBottom(); // Reveal without focusing the draft or opening the keyboard.
    } else if (down >= FOLD_DISTANCE && (start.top <= FOLD_DISTANCE || start.top - top >= LATEST_DISTANCE)) {
      if (gap > LATEST_DISTANCE) following = false;
      fold();
    }
  }, {passive:true});
  chat.addEventListener('touchcancel', () => { touchStart = null; }, {passive:true});
  const nonTouchScroll = () => {
    stopJump();
    if (touchScroll) rememberPosition();
    touchScroll = false;
  };
  chat.addEventListener('wheel', nonTouchScroll, {passive:true});
  chat.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') nonTouchScroll();
  }, {passive:true});
  chat.addEventListener('keydown', event => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) nonTouchScroll();
  });

  write.onclick = () => {
    stopJump();
    // Stop any outstanding momentum before focusing the real editor in place.
    const top = scrollTop();
    chat.scrollTop = top;
    following = !showLatest && bottom() - top <= 1;
    openComposer();
    draft.focus({preventScroll:true});
  };
  jump.onclick = scrollToLatest;
  return { latest, keepLatest, submitted, openComposer, update(compactable, hasDraft) {
    canCompact = compactable;
    const label = hasDraft ? 'Resume draft' : 'Open composer';
    if (write.ariaLabel !== label) {
      write.ariaLabel = write.title = label;
      write.textContent = hasDraft ? 'Resume draft…' : 'Message…';
    }
    layout();
  } };
}
