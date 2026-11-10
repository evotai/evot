import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AuthWatcher, readAuthStamp } from '../../../src/term/app/auth/auth-watch.js'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'evot-auth-watch-'))
}

// auth.json and models.cache.json are shared by every evot process, so one tab
// logging in must not leave the others holding a provider built from stale
// files. The stamp is the whole detection mechanism: if it moves, reload.
describe('readAuthStamp', () => {
  test('treats a missing state dir as a stable signed-out stamp', () => {
    const absent = join(tmpdir(), 'evot-auth-watch-absent')
    expect(readAuthStamp(absent)).toBe(readAuthStamp(absent))
  })

  test('is stable across reads when nothing changed', () => {
    const root = tempRoot()
    try {
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      expect(readAuthStamp(root)).toBe(readAuthStamp(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('moves when another process logs in or out', () => {
    const root = tempRoot()
    try {
      const signedOut = readAuthStamp(root)
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      const signedIn = readAuthStamp(root)
      expect(signedIn).not.toBe(signedOut)

      rmSync(join(root, 'auth.json'))
      expect(readAuthStamp(root)).toBe(signedOut)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('moves when a recovery re-mints the scoped key', () => {
    const root = tempRoot()
    try {
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      writeFileSync(join(root, 'models.cache.json'), '{"response":{"providers":[{"api_key":"evot.old"}]}}')
      const before = readAuthStamp(root)

      writeFileSync(join(root, 'models.cache.json'), '{"response":{"providers":[{"api_key":"evot.new"}]}}')
      expect(readAuthStamp(root)).not.toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('moves when the account behind an existing file changes', () => {
    const root = tempRoot()
    try {
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      const first = readAuthStamp(root)
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"c@d.dev"}}')
      expect(readAuthStamp(root)).not.toBe(first)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ignores a rewrite that produced identical bytes', () => {
    // Content hashing avoids a pointless provider reload when a sync rewrites
    // the same catalog.
    const root = tempRoot()
    try {
      const body = '{"response":{"providers":[{"api_key":"evot.same"}]}}'
      writeFileSync(join(root, 'models.cache.json'), body)
      const before = readAuthStamp(root)
      writeFileSync(join(root, 'models.cache.json'), body)
      expect(readAuthStamp(root)).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not confuse which file changed', () => {
    // Same bytes moved between the two watched files must not collide.
    const root = tempRoot()
    try {
      writeFileSync(join(root, 'auth.json'), '{"x":1}')
      const inAuth = readAuthStamp(root)
      rmSync(join(root, 'auth.json'))
      writeFileSync(join(root, 'models.cache.json'), '{"x":1}')
      expect(readAuthStamp(root)).not.toBe(inAuth)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** Wait until `predicate` holds, or fail after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for watcher notification')
}

describe('AuthWatcher', () => {
  test('fires when another process writes auth state', async () => {
    const root = tempRoot()
    let fired = 0
    const watcher = new AuthWatcher(() => { fired += 1 }, root)
    try {
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      await waitFor(() => fired > 0)
      expect(fired).toBe(1)
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('sees state published by an atomic rename', async () => {
    // Real writes land via temp file + rename, which is why the watcher must
    // watch the directory rather than the file: a file-level watch would go
    // deaf once rename replaced the inode it was bound to.
    const root = tempRoot()
    let fired = 0
    const watcher = new AuthWatcher(() => { fired += 1 }, root)
    try {
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"first@b.dev"}}')
      await waitFor(() => fired === 1)

      const temp = join(root, '.auth.json.tmp')
      writeFileSync(temp, '{"user":{"email":"second@b.dev"}}')
      renameSync(temp, join(root, 'auth.json'))
      await waitFor(() => fired === 2)
      expect(fired).toBe(2)
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('collapses the burst of a single login into one notification', async () => {
    const root = tempRoot()
    let fired = 0
    const watcher = new AuthWatcher(() => { fired += 1 }, root)
    try {
      // A login rewrites both files back to back.
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      writeFileSync(join(root, 'models.cache.json'), '{"schema_version":1}')
      await waitFor(() => fired > 0)
      // Allow any extra debounce window to elapse before asserting.
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(fired).toBe(1)
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('stays quiet for unrelated files in the state dir', async () => {
    const root = tempRoot()
    let fired = 0
    const watcher = new AuthWatcher(() => { fired += 1 }, root)
    try {
      writeFileSync(join(root, 'evot.env'), 'EVOT_LLM_PROVIDER=x')
      writeFileSync(join(root, 'update-check.json'), '{}')
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(fired).toBe(0)
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('sync() absorbs this process own write so it is not reported', async () => {
    const root = tempRoot()
    let fired = 0
    const watcher = new AuthWatcher(() => { fired += 1 }, root)
    try {
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      expect(watcher.sync()).toBe(true)
      // The watcher event still arrives, but the stamp is already current.
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(fired).toBe(0)
      expect(watcher.sync()).toBe(false)
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not fire after dispose', async () => {
    const root = tempRoot()
    let fired = 0
    const watcher = new AuthWatcher(() => { fired += 1 }, root)
    watcher.dispose()
    try {
      writeFileSync(join(root, 'auth.json'), '{"user":{"email":"a@b.dev"}}')
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(fired).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('starts without throwing when the state dir does not exist yet', () => {
    // Fresh install: ~/.evotai may not exist until the first login.
    const missing = join(tmpdir(), `evot-auth-watch-missing-${Date.now()}`)
    const watcher = new AuthWatcher(() => {}, missing)
    try {
      expect(watcher.getStamp()).toBe(readAuthStamp(missing))
    } finally {
      watcher.dispose()
    }
  })
})
