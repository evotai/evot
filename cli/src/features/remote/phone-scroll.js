// Scrolling and editing are independent: once folded, only an explicit action
// reopens the composer. A viewport resize or the tail of a swipe cannot do it.
const FOLD_DISTANCE = 72;
const HANDLE_DISTANCE = 24;
const LATEST_DISTANCE = 16;
const pulledDown = (start, end, distance) => {
  const down = end.clientY - start.clientY;
  return down >= distance && down > Math.abs(end.clientX - start.clientX);
};

export function conversationScroll({ chat, seat, editor, write, jump, foldHandle, draft }) {
  let following = true, showLatest = false, compact = false, canCompact = false, shownCompact = false;
  let lastTop = 0, backFrom = 0, lastHeight = 0, touchStart = null, touchScroll = false, drag = null, dragged = false;
  const { ownerDocument } = chat;
  // Safari can report negative or past-bottom positions during rubber-banding.
  const bottom = () => Math.max(0, chat.scrollHeight - chat.clientHeight);
  const scrollTop = () => Math.max(0, Math.min(chat.scrollTop, bottom()));
  const rememberPosition = () => { lastHeight = chat.clientHeight; backFrom = lastTop = scrollTop(); };
  function layout() {
    const folded = compact && canCompact;
    const hideJump = !folded && !showLatest;
    const focused = ownerDocument.activeElement;
    if ((hideJump && focused === jump) || (!folded && focused === write) ||
        ((folded || !canCompact) && focused === foldHandle) || (folded && editor.contains(focused))) {
      chat.focus({preventScroll:true});
    }
    write.inert = !folded;
    jump.hidden = hideJump;
    foldHandle.hidden = folded || !canCompact;
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
  function latest() {
    following = true;
    showLatest = compact = false;
    layout();
    keepLatest();
  }
  function fold() {
    if (!canCompact || compact) return;
    showLatest ||= !following;
    following = false;
    compact = true;
    layout();
  }
  chat.addEventListener('scroll', () => {
    if (!chat.clientHeight) return;
    if (chat.clientHeight !== lastHeight) { rememberPosition(); return; }
    const top = scrollTop(), previous = lastTop, gap = bottom() - top;
    lastTop = top;
    if (top > previous) {
      backFrom = top;
      if (!compact && !following && gap <= LATEST_DISTANCE) latest();
    } else if (top < previous) {
      if (gap <= 1) { backFrom = top; return; } // Layout can clamp to an earlier bottom.
      following = false;
      if (gap >= FOLD_DISTANCE) showLatest = true;
      if (!touchScroll && backFrom - top >= FOLD_DISTANCE) fold();
    }
    layout();
  }, {passive:true});
  new ownerDocument.defaultView.ResizeObserver(() => {
    if (following) keepLatest();
    else if (chat.clientHeight !== lastHeight || scrollTop() !== lastTop) rememberPosition();
  }).observe(chat);

  // Listen without taking over native scrolling. The whole touch gesture (not
  // a scroll event or its momentum) decides whether to fold on release.
  chat.addEventListener('touchstart', event => {
    touchScroll = true;
    touchStart = event.touches.length === 1 ? {touch:event.touches[0], top:scrollTop()} : null;
  }, {passive:true});
  chat.addEventListener('touchend', event => {
    const start = touchStart;
    touchStart = null;
    const end = start && Array.from(event.changedTouches).find(touch => touch.identifier === start.touch.identifier);
    if (end && (start.top <= FOLD_DISTANCE || start.top - scrollTop() >= LATEST_DISTANCE) &&
        pulledDown(start.touch, end, FOLD_DISTANCE)) fold();
  }, {passive:true});
  chat.addEventListener('touchcancel', () => { touchStart = null; }, {passive:true});
  const nonTouchScroll = () => {
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

  foldHandle.onclick = event => { if (!dragged || event.detail === 0) fold(); };
  foldHandle.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    dragged = false;
    drag = event;
    foldHandle.setPointerCapture(event.pointerId);
  };
  foldHandle.onpointerup = event => {
    if (drag?.pointerId !== event.pointerId) return;
    const start = drag;
    drag = null;
    dragged = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) >= HANDLE_DISTANCE;
    if (pulledDown(start, event, HANDLE_DISTANCE)) fold();
  };
  foldHandle.onpointercancel = foldHandle.onlostpointercapture = () => { drag = null; };
  write.onclick = () => {
    // Stop any outstanding momentum before focusing the real editor in place.
    const top = scrollTop();
    chat.scrollTop = top;
    following = !showLatest && bottom() - top <= 1;
    compact = false;
    layout();
    draft.focus({preventScroll:true});
    keepLatest();
  };
  // One move, not a native smooth scroll competing with the composer resize.
  jump.onclick = latest;
  return { latest, keepLatest, update(compactable, hasDraft) {
    canCompact = compactable;
    const label = hasDraft ? 'Resume draft' : 'Open composer';
    if (write.ariaLabel !== label) {
      write.ariaLabel = write.title = label;
      write.textContent = hasDraft ? 'Resume draft…' : 'Message…';
    }
    layout();
  } };
}
