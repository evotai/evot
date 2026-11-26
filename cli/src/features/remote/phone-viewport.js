// Mobile Safari can shrink/pan only the visual viewport when the keyboard opens.
// Keep the conversation and its in-flow dock inside it, without fighting pinch zoom.
// A phone with its keyboard open leaves well under this much height: the draft
// and its send row then take priority over the transcript and the run line.
export const TIGHT_VIEWPORT_PX = 520;
const PHONE = '(pointer: coarse) and (max-width: 600px)';
const editable = el => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');

export function fitConversationViewport(conversation) {
  const doc = conversation.ownerDocument, win = doc.defaultView, viewport = win.visualViewport;
  if (!viewport) return;
  function fit() {
    const { height, offsetTop, scale } = viewport;
    if (Math.abs(scale - 1) > 0.01 || height <= 0) {
      conversation.style.removeProperty('--remote-viewport-height');
      conversation.style.removeProperty('--remote-viewport-top');
      conversation.toggleAttribute('data-tight', false);
      return;
    }
    conversation.style.setProperty('--remote-viewport-height', `${Math.floor(height)}px`);
    conversation.style.setProperty('--remote-viewport-top', `${Math.max(0, offsetTop)}px`);
    // Switch the layout as a phone field gains focus, before the keyboard resizes
    // the viewport. iOS keeps the caret where the field was when focus arrived, so
    // a later rearrangement would leave it above the text.
    const typing = editable(doc.activeElement) && !!win.matchMedia?.(PHONE).matches;
    conversation.toggleAttribute('data-tight', typing || height < TIGHT_VIEWPORT_PX);
  }
  viewport.addEventListener('resize', fit);
  viewport.addEventListener('scroll', fit);
  doc.addEventListener('focusin', fit);
  doc.addEventListener('focusout', () => setTimeout(fit)); // activeElement updates after the event
  fit();
}
