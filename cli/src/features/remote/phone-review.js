// A separate, lazy document keeps diff2html and review state out of chat.
// Browser Back dismisses it without unloading the chat or resetting its scroll.
export function reviewNavigation(dialog, button, target) {
  let showing = null;
  function sync() {
    const terminal = target();
    const wanted = terminal && terminal === history.state?.reviewTerminal ? terminal : null;
    if (wanted === showing) return;
    showing = wanted;
    dialog.replaceChildren();
    if (!wanted) { if (dialog.open) dialog.close(); return; }
    const frame = document.createElement('iframe');
    frame.title = 'Working tree changes';
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    frame.src = '/changes?' + new URLSearchParams({terminal:wanted,theme});
    dialog.append(frame);
    if (!dialog.open) dialog.showModal();
  }
  button.onclick = () => {
    if (!target()) return;
    history.pushState({...history.state, reviewTerminal:target()}, '', '?changes');
    sync();
  };
  window.addEventListener('popstate',sync);
  window.addEventListener('message',e=>{
    if (e.origin===location.origin && e.source===dialog.firstChild?.contentWindow && e.data==='evot-close-changes') history.back();
  });
  dialog.addEventListener('cancel',e=>{e.preventDefault();history.back();});
  return sync;
}
