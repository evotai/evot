// Photos for the next message. Scaled on the phone so a 12 MP picture is a few
// hundred KB on the wire; the computer's engine resizes again if a model needs it.
const MAX_SIDE = 2000, QUALITY = 0.85, MAX_IMAGES = 4;

async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok, fail) => canvas.toBlob(b => b ? ok(b) : fail(Error('encode')), 'image/jpeg', QUALITY));
    const data = await new Promise((ok, fail) => {
      const reader = new FileReader();
      reader.onload = () => ok(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => fail(reader.error);
      reader.readAsDataURL(blob);
    });
    return { mimeType: 'image/jpeg', data, url: URL.createObjectURL(blob) };
  } finally { bitmap.close?.(); }
}

export function imageTray({ tray, input, button, changed, notice }) {
  let items = [], adding = 0;
  function paint() {
    tray.hidden = !items.length && !adding;
    tray.replaceChildren(...items.map((item, index) => {
      const cell = document.createElement('div'); cell.className = 'attachment';
      const img = document.createElement('img'); img.src = item.url; img.alt = `Photo ${index + 1}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
      remove.onclick = () => { URL.revokeObjectURL(item.url); items.splice(index, 1); paint(); };
      cell.append(img, remove);
      return cell;
    }), ...(adding ? [Object.assign(document.createElement('div'), { className: 'attachment loading', textContent: '…' })] : []));
    button.disabled = items.length + adding >= MAX_IMAGES;
    changed();
  }
  async function add(files) {
    const room = MAX_IMAGES - items.length - adding, picked = [...files].filter(f => f.type.startsWith('image/'));
    if (picked.length > room) notice(`Up to ${MAX_IMAGES} photos per message.`);
    const batch = picked.slice(0, Math.max(0, room));
    adding += batch.length; paint();
    for (const file of batch) {
      try { items.push(await shrink(file)); }
      catch { notice(`Could not read ${file.name || 'that photo'}. Try another format.`); }
      finally { adding--; paint(); }
    }
  }
  button.onclick = () => input.click();
  input.onchange = () => { void add(input.files ?? []); input.value = ''; };
  return {
    add,
    get busy() { return adding > 0; },
    get count() { return items.length; },
    /** Hand the photos to a send; `restore` puts them back if it fails. */
    take() {
      const taken = items; items = []; paint();
      return { images: taken.map(({ mimeType, data }) => ({ mimeType, data })), urls: taken.map(i => i.url),
        restore() { items = [...taken, ...items].slice(0, MAX_IMAGES); paint(); },
        release() { for (const i of taken) URL.revokeObjectURL(i.url); } };
    },
    clear() { for (const i of items) URL.revokeObjectURL(i.url); items = []; paint(); },
  };
}
