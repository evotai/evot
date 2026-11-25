// The dialog owns its URL, so removing a thumbnail (e.g. a queue update) doesn't
// blank an open preview. Closing never changes the attachment or composer state.
export function photoViewer(dialog) {
  const image = dialog.querySelector('img');
  let url;
  function release() {
    image.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  const close = () => { if (dialog.open) dialog.close(); release(); };
  dialog.querySelector('button').onclick = close;
  dialog.onclick = e => { if (e.target === dialog) close(); };
  dialog.onclose = () => { if (!dialog.open) release(); };
  return {close, thumbnail(photo,index) {
    const name = `Photo ${index+1}`, button = document.createElement('button'), thumb = document.createElement('img');
    button.type = 'button'; button.className = 'photo-thumb'; button.setAttribute('aria-haspopup','dialog');
    button.setAttribute('aria-label',`Enlarge photo ${index+1}`);
    thumb.alt = name; thumb.src = photo.url; button.append(thumb);
    button.onclick = () => {
      release(); url = URL.createObjectURL(photo.blob);
      image.src = url; image.alt = name; dialog.showModal();
    };
    return button;
  }};
}

// Only keep local thumbnails while their exact submitted message is still in the
// visible tail. Repeated captions (especially photo-only sends) are not identities.
export function messagePhotos() {
  const entries = new Map();
  function prune(messages) {
    const keep = new Set(messages.filter(m => m.role === 'user').map(m => m.photoId));
    for (const [id,photos] of entries) if (!keep.has(id)) {
      for (const photo of photos) URL.revokeObjectURL(photo.url);
      entries.delete(id);
    }
  }
  return {prune, get:id => entries.get(id), remember:(id,photos) => entries.set(id,photos)};
}
