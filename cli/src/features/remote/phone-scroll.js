// Sending and reading history give space back to the transcript. Latest,
// momentum, and run updates never reopen the composer.
const FOLD_DISTANCE = 72;
const TOUCH_FOLD_DISTANCE = 24;
const REVEAL_DISTANCE = 32;
const LATEST_DISTANCE = 16;

export function conversationScroll({ chat, seat, editor, dock, write, jump, draft, compactChanged }) {
  let following = true, showLatest = false, compact = false, canCompact = false, shownCompact = false;
  let lastTop = 0, backFrom = 0, lastHeight = 0, touchStart = null, touchScroll = false;
  const { ownerDocument } = chat, window = ownerDocument.defaultView;
  let jumpFrame = null, pendingPaint = null;
  function observeBackwardScroll() {
    // A fold/keyboard resize may run before the native scroll event. Clamping
    // to a shorter bottom is layout; moving farther back is the reader.
    if (following && chat.clientHeight && scrollTop() < Math.min(lastTop,bottom()) - 1) {
      following = false; showLatest = true; layout();
    }
  }
  // Keep one latest frame, not a growing backlog. The host sends a bounded
  // tail: repainting it while reading could evict the very row on screen.
  function paintHistory(paint) {
    // Native scrollTop can change before its scroll event is delivered.
    observeBackwardScroll();
    if (following) paint();
    else { pendingPaint = paint; showLatest = true; layout(); }
  }
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
      compactChanged?.(folded);
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
    const paint = pendingPaint; pendingPaint = null;
    paint?.();
    showLatest = false;
    layout();
    keepLatest();
  }
  function latest() {
    pendingPaint = null; // Resetting or changing the session discards the old view.
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
    if (chat.clientHeight !== lastHeight) { observeBackwardScroll(); rememberPosition(); return; }
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
    observeBackwardScroll();
    if (following) keepLatest();
    else if (chat.clientHeight !== lastHeight || scrollTop() !== lastTop) rememberPosition();
  }).observe(chat);

  // Leave native scrolling alone, but fold as soon as the finger drags
  // toward history. Momentum can't fold the composer or reveal it at the bottom.
  chat.addEventListener('touchstart', event => {
    stopJump();
    touchScroll = true;
    const rail = event.target?.closest('.tool-rail');
    const nestedScroll = rail && rail.scrollHeight > rail.clientHeight;
    touchStart = event.touches.length === 1 && !nestedScroll
      ? {touch:event.touches[0], gap:bottom() - scrollTop(), folded:shownCompact}
      : null;
  }, {passive:true});
  chat.addEventListener('touchmove', event => {
    if (event.touches.length !== 1) { touchStart = null; return; }
    const start = touchStart, touch = event.touches[0];
    if (!start || start.folded || !canCompact || compact || touch.identifier !== start.touch.identifier) return;
    const down = touch.clientY - start.touch.clientY;
    if (down < TOUCH_FOLD_DISTANCE || down <= Math.abs(touch.clientX - start.touch.clientX)) return;
    // Native scroll events may arrive after touchmove. Stop auto-following
    // now so a streaming update can't pull the viewport back to the live edge.
    if (bottom() > 0) following = false;
    fold();
  }, {passive:true});
  chat.addEventListener('touchend', event => {
    const start = touchStart;
    touchStart = null;
    const end = start && Array.from(event.changedTouches).find(touch => touch.identifier === start.touch.identifier);
    if (!end) return;
    const down = end.clientY - start.touch.clientY, gap = bottom() - scrollTop();
    if (Math.abs(down) <= Math.abs(end.clientX - start.touch.clientX)) return;
    if (start.folded && shownCompact && gap <= LATEST_DISTANCE && -down >= start.gap + REVEAL_DISTANCE) {
      compact = false;
      followBottom(); // Reveal without focusing the draft or opening the keyboard.
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
  return { latest, keepLatest, paintHistory, submitted, openComposer, update(compactable, hasDraft) {
    canCompact = compactable;
    const label = hasDraft ? 'Resume draft' : 'Open composer';
    if (write.ariaLabel !== label) {
      write.ariaLabel = write.title = label;
      write.textContent = hasDraft ? 'Resume draft…' : 'Message…';
    }
    layout();
  } };
}
