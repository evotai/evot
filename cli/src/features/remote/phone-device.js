// The private key is deliberately non-exportable; losing site data means approving again.
const request = (r) =>
  new Promise((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
const encode = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
async function identity() {
  const open = indexedDB.open('evot-remote-devices', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('keys');
  const db = await request(open);
  try {
    const found = await request(db.transaction('keys').objectStore('keys').get('device'));
    if (found) return found;
    const fresh = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const tx = db.transaction('keys', 'readwrite'),
      store = tx.objectStore('keys');
    const done = new Promise((ok, fail) => {
      tx.oncomplete = ok;
      tx.onabort = () => fail(tx.error);
    });
    const previous = await request(store.get('device'));
    if (!previous) store.put(fresh, 'device');
    await done;
    return previous || fresh;
  } finally {
    db.close();
  }
}
const fragment = new URLSearchParams(location.hash.slice(1));
export const returnTicket = fragment.get('ticket');
// The QR selects where to show approval, not which conversation to open.
export const invitedTerminal = location.hash ? fragment.get('terminal') : window.history?.state?.evotPairingWindow ?? null;
if (location.hash) history.replaceState({...history.state, evotPairingWindow: invitedTerminal}, '', location.pathname);
// A second invite opened in the same tab can be a fragment-only navigation:
// the browser does not run the module again unless we reload that entry.
window.addEventListener('hashchange', () => {
  const next = new URLSearchParams(location.hash.slice(1));
  if (next.has('terminal') || next.has('ticket')) location.reload();
});
let ticket = returnTicket;
export async function connectDevice(post, progress, redirect) {
  // Bound local key storage separately from the network and approval poll.
  // A stuck IndexedDB open must not leave Connecting… spinning indefinitely.
  let pair, timer;
  try {
    if (!window.indexedDB) throw Error('Device storage is unavailable. Open this invite in Safari or Chrome with site data enabled.');
    pair = await Promise.race([identity(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Device storage did not respond. Close other Connect tabs and try again.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
  const key = encode(await crypto.subtle.exportKey('raw', pair.publicKey));
  const attestation = ticket;
  ticket = null;
  const { nonce, login } = await post('/device/challenge', { key, ticket: attestation, terminal: invitedTerminal ?? undefined });
  if (login) {
    progress('signin');
    redirect(login);
    return null;
  }
  progress('verify');
  const signature = encode(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode('evot-device-v1:' + nonce)
    )
  );
  let reply = await post('/device/prove', { nonce, signature });
  if (!reply.token) {
    const { code, receipt } = reply;
    const deadline = Date.now() + (reply.remainingMs ?? 120000);
    progress('approval', code, deadline);
    do {
      await new Promise((ok) => setTimeout(ok, 1000));
      if (Date.now() >= deadline) throw Error('Approval expired. Request a new code.');
      try {
        reply = await post('/device/poll', { receipt });
      } catch (error) {
        if (error.status === 403) throw Error('Approval is no longer pending. Connect again to request a new code.');
        if (error.status && error.status < 500) throw error;
        reply = {pending:true}; // network loss: keep the same pending request
      }
    } while (reply.pending);
  }
  return reply;
}
