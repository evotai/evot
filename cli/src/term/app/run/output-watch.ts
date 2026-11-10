/** Filesystem-driven output updates. No polling timer; notifications coalesce per event-loop turn. */
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

export function watchOutputFile(path: string, changed: () => void, failed: (error: Error) => void): () => void {
  let closed = false
  let pending: ReturnType<typeof setImmediate> | undefined
  let file: FSWatcher | undefined
  const notify = () => {
    if (closed || pending) return
    pending = setImmediate(() => {
      pending = undefined
      if (!closed) changed()
    })
  }
  const bindFile = () => {
    file?.close()
    file = undefined
    try {
      file = watch(path, { persistent: false }, notify)
      file.on('error', error => { if (!closed) failed(error) })
    } catch (error) {
      // Replacement can briefly remove the path. The directory subscription
      // will bind the new file when it appears.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // macOS directory watches report entry changes, not every write to a file.
  // Watch the inode for writes and its directory for replacement/deletion.
  const directory = watch(dirname(path), { persistent: false }, (_event, name) => {
    if (closed || (name !== null && name.toString() !== basename(path))) return
    try { bindFile(); notify() } catch (error) { failed(error instanceof Error ? error : new Error(String(error))) }
  })
  directory.on('error', error => { if (!closed) failed(error) })
  try { bindFile() } catch (error) { directory.close(); throw error }
  return () => {
    closed = true
    if (pending) clearImmediate(pending)
    file?.close()
    directory.close()
  }
}
