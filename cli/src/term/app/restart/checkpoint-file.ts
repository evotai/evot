import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeRestartCheckpoint, type RestartCheckpoint } from './checkpoint.js'

/** The next image finds its checkpoint through this variable, set only for the execve. */
export const RESTART_CHECKPOINT_ENV = 'EVOT_RESTART_CHECKPOINT'
const NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/
// Drafts can carry pasted images; a restart that never came back must not leave them forever.
const ABANDONED_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 128 * 1024 * 1024

function privateDirectory(home: string): string {
  const dir = join(home, 'restart')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Unsafe restart directory permissions.')
  return dir
}

function pruneAbandoned(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try { if (now - statSync(path).mtimeMs > ABANDONED_MS) rmSync(path, { force: true }) } catch { /* another process took it */ }
  }
}

/** Same-directory temporary file, flushed, then renamed: the reader sees all of it or nothing. */
export function writeRestartCheckpoint(home: string, checkpoint: RestartCheckpoint, now = Date.now()): string {
  const dir = privateDirectory(home)
  pruneAbandoned(dir, now)
  const path = join(dir, `${randomUUID()}.json`), staging = `${path}.tmp`
  const fd = openSync(staging, 'wx', 0o600)
  try {
    writeSync(fd, JSON.stringify(checkpoint))
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(staging, { force: true })
    throw error
  }
  closeSync(fd)
  try { renameSync(staging, path) } catch (error) { rmSync(staging, { force: true }); throw error }
  return path
}

export type TakenCheckpoint = { checkpoint: RestartCheckpoint | null; error: string | null }

/** Reads and removes the checkpoint this process was started with. Only a
 * checkpoint file inside the restart directory is ever read or deleted. */
export function takeRestartCheckpoint(home: string, path: string | undefined): TakenCheckpoint {
  if (!path) return { checkpoint: null, error: null }
  let dir: string
  try { dir = privateDirectory(home) } catch (error) { return { checkpoint: null, error: (error as Error).message } }
  const file = resolve(path)
  if (dirname(file) !== resolve(dir) || !NAME.test(basename(file))) return { checkpoint: null, error: 'Ignored a restart checkpoint outside the restart directory.' }
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_BYTES) return { checkpoint: null, error: 'Restart checkpoint is not a readable file.' }
    return { checkpoint: decodeRestartCheckpoint(JSON.parse(readFileSync(file, 'utf8'))), error: null }
  } catch (error) {
    return { checkpoint: null, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Restart checkpoint was already used.' : (error as Error).message }
  } finally {
    rmSync(file, { force: true })
  }
}

/** A restart that could not exec removes its own checkpoint. */
export function discardRestartCheckpoint(path: string): void {
  rmSync(path, { force: true })
}
