// Mobile Safari can shrink/pan only the visual viewport when the keyboard opens.
// Keep the conversation and its in-flow dock inside it, without fighting pinch zoom.
export function fitConversationViewport(conversation) {
  const viewport = conversation.ownerDocument.defaultView.visualViewport;
  if (!viewport) return;
  function fit() {
    const { height, offsetTop, scale } = viewport;
    if (Math.abs(scale - 1) > 0.01 || height <= 0) {
      conversation.style.removeProperty('--remote-viewport-height');
      conversation.style.removeProperty('--remote-viewport-top');
      return;
    }
    conversation.style.setProperty('--remote-viewport-height', `${Math.floor(height)}px`);
    conversation.style.setProperty('--remote-viewport-top', `${Math.max(0, offsetTop)}px`);
  }
  viewport.addEventListener('resize', fit);
  viewport.addEventListener('scroll', fit);
  fit();
}
