import { pendingDrafts } from './phone-queue.js';

// Photos ride in the request body; a phone uplink can need tens of seconds for
// them. Allow for a slow link instead of abandoning bytes that are still moving.
const BASE_MS = 8000, SLOW_UPLINK_BYTES_PER_MS = 16, MAX_MS = 300_000;
export function requestTimeout(path, bodyBytes = 0) {
  if (path.startsWith('/sessions?limit=')) return 30000;
  if (path === '/open') return 15000;
  return Math.min(MAX_MS, BASE_MS + Math.ceil(bodyBytes / SLOW_UPLINK_BYTES_PER_MS));
}

/** Fetch doesn't expose upload events. Use the browser's byte counters for photo
 * requests, including the inline fallback. A completed upload is not admission. */
export function uploadRequest(path, payload, headers, timeout, progress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    if (signal?.aborted) { reject(signal.reason); return; }
    xhr.open('POST', path);
    xhr.timeout = timeout;
    for (const [key,value] of Object.entries(headers)) xhr.setRequestHeader(key,value);
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(e.loaded,e.total); };
    xhr.onload = () => resolve(new Response(xhr.status === 204 ? null : xhr.responseText, {
      status:xhr.status, headers:{ 'x-evot-build':xhr.getResponseHeader('x-evot-build') ?? '' } }));
    xhr.onerror = () => reject(new TypeError('Upload connection lost.'));
    xhr.ontimeout = () => reject(new DOMException('Upload timed out.', 'TimeoutError'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));
    xhr.onloadend = () => signal?.removeEventListener('abort',abort);
    signal?.addEventListener('abort',abort,{once:true});
    xhr.send(payload);
  });
}

/** The computer answered and refused. Any other failure (timeout, dropped
 * connection, tunnel 5xx) may have happened after it accepted the message. */
export function refused(error) {
  return error?.status >= 400 && error.status < 500;
}

/** The computer no longer holds a photo uploaded ahead of the message (412). */
export const photoExpired = error => error?.status === 412;

/** Whether the computer has this message: in the transcript or still queued. */
export function delivered(view, draftId) {
  if (!view || !draftId) return false;
  return view.messages.some(m => m.role === 'user' && m.photoId === draftId) || !!pendingDrafts(view)?.includes(draftId);
}

/** How long to watch for an uncertain send before handing the draft back. */
export const CONFIRM_MS = 15000;
