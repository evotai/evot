// Follow the live conversation until the reader deliberately scrolls away.
// The compact bar is only a view: it never moves or replaces the editor.
export function conversationScroll({ chat, seat, actions, write, jump, draft }) {
  let following = true, compact = false, canCompact = false, jumpTarget = null;
  const { ownerDocument } = chat, window = ownerDocument.defaultView;
  function layout() {
    const showCompact = !following && compact && canCompact;
    const hideJump = following || jumpTarget !== null;
    const focused = ownerDocument.activeElement;
    if ((hideJump && actions.contains(focused)) || (!showCompact && focused === write)) {
      chat.focus({preventScroll:true});
    }
    seat.toggleAttribute('data-reading', showCompact);
    write.hidden = !showCompact;
    jump.hidden = hideJump;
  }
  function keepLatest() {
    if (following) chat.scrollTop = chat.scrollHeight;
  }
  function latest() {
    jumpTarget = null;
    following = true;
    compact = false;
    layout();
    keepLatest();
  }
  function animateToBottom() {
    jumpTarget = chat.scrollHeight - chat.clientHeight;
    if (jumpTarget - chat.scrollTop <= 1) { latest(); return; }
    chat.scrollTo({top:jumpTarget, behavior:'smooth'});
  }
  function interruptJump() {
    if (jumpTarget === null) return;
    jumpTarget = null;
    chat.scrollTop = chat.scrollTop; // Cancel the native animation, even before the gesture scrolls.
    layout();
  }
  chat.addEventListener('scroll', () => {
    if (!chat.clientHeight) return;
    const gap = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    if (jumpTarget !== null) {
      // If a reply grew while we scrolled, finish at the new bottom too.
      if (gap <= 1) latest();
      else if (chat.scrollTop >= jumpTarget - 1) animateToBottom();
      return;
    }
    if (!following && gap <= 16) { latest(); return; }
    if (gap < 80) return;
    following = false;
    const focused = ownerDocument.activeElement;
    // Leave room for the larger transcript viewport after folding. Fold on
    // scroll, not blur: a touch blur can precede the click on Send.
    if (!compact && gap >= seat.offsetHeight && (!seat.contains(focused) || actions.contains(focused))) compact = true;
    layout();
  }, {passive:true});
  // Resizing the editor or opening the soft keyboard should only pin the
  // transcript if it was already following, never when reading history.
  new window.ResizeObserver(keepLatest).observe(chat);
  chat.addEventListener('pointerdown', interruptJump, {passive:true});
  chat.addEventListener('wheel', interruptJump, {passive:true});
  chat.addEventListener('keydown', event => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) interruptJump();
  });
  write.onclick = () => {
    compact = false;
    layout();
    draft.focus({preventScroll:true});
  };
  jump.onclick = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { latest(); return; }
    // Measure the final viewport first so opening the editor won't jump the
    // last few lines after the smooth scroll has already finished.
    jumpTarget = 0;
    compact = false;
    layout();
    animateToBottom();
  };
  return { latest, keepLatest, update(compactable, hasDraft) {
    canCompact = compactable;
    const label = hasDraft ? 'Resume draft' : 'Open composer';
    if (write.ariaLabel !== label) write.ariaLabel = write.title = label;
    write.toggleAttribute('data-has-draft', hasDraft);
    layout();
  } };
}
