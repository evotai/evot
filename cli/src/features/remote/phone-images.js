// Work starts at selection. The tray and each submitted message own separate batches:
// moving a photo into the conversation never waits for a decoder or a network reply.
const MAX_SIDE = 1600, QUALITY = 0.76, MAX_IMAGES = 4;

// Read synchronously inside the paste event: the browser can revoke access to
// DataTransferItem after dispatch. Some clipboards expose a bitmap only here,
// not in files; when both lists contain it, attach it just once.
export function pastePhotos(event, add) {
  const data = event.clipboardData;
  if (!data) return;
  const isPhoto = file => file?.type.startsWith('image/');
  const files = Array.from(data.files ?? []).filter(isPhoto);
  const items = Array.from(data.items ?? []).filter(item => item.kind === 'file')
    .map(item => item.getAsFile()).filter(isPhoto);
  const picked = items.length > files.length ? items : files;
  if (!picked.length) return; // Keep native text paste (including URLs and IME).
  event.preventDefault();
  add(picked);
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((ok, fail) => canvas.toBlob(b => b ? ok(b) : fail(Error('encode')), 'image/jpeg', QUALITY));
  } finally { bitmap.close?.(); }
}

async function inline({ blob }) {
  const data = await new Promise((ok, fail) => {
    const reader = new FileReader();
    reader.onload = () => ok(String(reader.result).split(',')[1]);
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(blob);
  });
  return { mimeType: blob.type, data };
}

export function imageTray({ tray, input, button, thumbnail, changed, notice, upload, prepare = shrink }) {
  const document = tray.ownerDocument;
  let items = [], decoder = Promise.resolve();
  function release(item) {
    item.abort.abort();
    if (item.preview) URL.revokeObjectURL(item.preview.url);
  }
  function paint() {
    tray.hidden = !items.length;
    tray.replaceChildren(...items.map((item, index) => {
      const cell = document.createElement('div'); cell.className = 'attachment';
      if (item.preview) cell.append(thumbnail(item.preview,index));
      else cell.textContent = item.error ? '!' : '…';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-photo'; remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
      remove.onclick = () => { release(item); items.splice(index, 1); paint(); };
      cell.append(remove); return cell;
    }));
    button.disabled = items.length >= MAX_IMAGES;
    changed();
  }
  function add(files) {
    const room = MAX_IMAGES - items.length, picked = [...files].filter(f => f.type.startsWith('image/'));
    if (picked.length > room) notice(`Up to ${MAX_IMAGES} photos per message.`);
    for (const file of picked.slice(0, Math.max(0, room))) {
      const item = { abort:new AbortController(), loaded:0 };
      items.push(item);
      // Decode one full camera image at a time; uploads can overlap the next decode.
      decoder = decoder.then(async () => {
        if (item.abort.signal.aborted) return;
        try {
          const blob = await prepare(file);
          if (!item.abort.signal.aborted) item.preview = { blob, url:URL.createObjectURL(blob) };
        } catch { item.error = `Could not read ${file.name || 'photo'}. Remove it or choose another format.`; }
        if (items.includes(item)) paint();
        item.notify?.();
      });
      item.ready = decoder.then(async () => {
        if (!item.preview || item.abort.signal.aborted) return;
        try {
          item.ref = await upload(item.preview.blob, loaded => { item.loaded = loaded; item.notify?.(); }, item.abort.signal);
        } catch { /* An older gateway or a lost receipt: keep the JPEG for an inline send. */ }
        item.notify?.();
      });
    }
    paint();
  }
  button.onclick = () => input.click();
  input.onchange = () => { add(input.files ?? []); input.value = ''; };
  return {
    add, get count() { return items.length; },
    take() {
      const taken = items; items = []; paint();
      const previews = () => taken.flatMap(i => i.preview ? [i.preview] : []);
      return { count:taken.length, previews,
        async ready(update) {
          const report = () => {
            const ready = previews(), total = ready.reduce((sum,p) => sum + p.blob.size, 0);
            const loaded = taken.reduce((sum,i) => sum + (i.ref ? i.preview.blob.size : i.loaded), 0);
            if (ready.length < taken.length) update(ready, `Preparing photos · ${ready.length}/${taken.length}`, null);
            else if (loaded >= total) update(ready, 'Waiting for upload receipt…', null);
            else {
              const percent = Math.floor(100 * loaded / total);
              update(ready, `Uploading · ${percent}%`, percent);
            }
          };
          for (const i of taken) i.notify = report;
          try {
            report(); await Promise.all(taken.map(i => i.ready));
            const unreadable = taken.find(i => i.error);
            if (unreadable) throw Error(unreadable.error);
          } finally { for (const i of taken) i.notify = null; }
        },
        images: allInline => Promise.all(taken.map(i => i.ref && !allInline ? { ref:i.ref } : inline(i.preview))),
        restore() { items = [...taken, ...items]; paint(); },
        release() { taken.forEach(release); } };
    },
    clear() { items.forEach(release); items = []; paint(); },
  };
}
