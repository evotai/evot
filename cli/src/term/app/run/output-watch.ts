/** Filesystem-driven output updates. No polling timer; notifications coalesce per event-loop turn. */
import { statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

export function watchOutputFile(path: string, changed: () => void, failed: (error: Error) => void): () => void {
  let closed = false
  let pending: ReturnType<typeof setImmediate> | undefined
  let file: FSWatcher | undefined
  let identity: {dev: number; ino: number} | undefined
  let dirty = false
  const name = basename(path)
  function reconcile() {
    if (closed) return
    try {
      const stat = statSync(path, { throwIfNoEntry: false })
      if (stat && (!file || stat.dev !== identity?.dev || stat.ino !== identity?.ino)) {
        // A file and its parent can both signal the same write. Don't tear down
        // the inode subscription unless the directory entry actually changed.
        const next = watch(path, { persistent: false }, () => notify(true))
        next.on('error', error => { if (!closed && file === next) failed(error) })
        file?.close()
        file = next
        identity = stat
        return true
      } else if (!stat && file) {
        file.close(); file = undefined; identity = undefined
        return true
      }
    } catch (error) {
      // The file may disappear between stat and watch; the parent stays subscribed.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  function notify(targetChanged: boolean) {
    dirty ||= targetChanged
    if (closed || pending) return
    pending = setImmediate(() => {
      pending = undefined
      if (closed) return
      let rebound
      try { rebound = reconcile() } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); return }
      const refresh = rebound || dirty
      dirty = false
      if (refresh) changed()
    })
  }
  const directory = watch(dirname(path), { persistent: false }, (_event, entry) => {
    // A coalesced rename on macOS can name only the source (a sibling).
    // Check the target inode even then; unrelated writes don't redraw it.
    notify(entry === null || entry.toString() === name)
  })
  directory.on('error', error => { if (!closed) failed(error) })
  try { reconcile() } catch (error) { directory.close(); throw error }
  return () => {
    closed = true
    if (pending) clearImmediate(pending)
    file?.close()
    directory.close()
  }
}
