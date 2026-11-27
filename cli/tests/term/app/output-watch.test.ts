import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchOutputFile } from '../../../src/term/app/run/output-watch.js'
import { readOutputTail } from '../../../src/term/app/run/output-tail.js'

test('output subscription receives writes and replacement without a polling timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-output-watch-'))
  const path = join(root, 'output')
  writeFileSync(path, '')
  let resolveChange: (() => void) | undefined
  let rejectChange: ((error: Error) => void) | undefined
  let latest = ''
  const close = watchOutputFile(path, () => { latest = readOutputTail(path); resolveChange?.() }, error => rejectChange?.(error))
  const change = async (expected: string, write: () => void) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        resolveChange = () => { if (latest === expected) resolve() }
        rejectChange = reject
        timeout = setTimeout(() => reject(new Error(`waiting for ${expected}; last notification read ${JSON.stringify(latest)}`)), 1500)
        write()
      })
    } finally { clearTimeout(timeout); resolveChange = undefined; rejectChange = undefined }
  }
  try {
    // fs.watch has no ready event. On macOS its first notification may be
    // missed during startup. Establish readiness through the watcher itself;
    // none of the writes under test are repeated or read by a polling loop.
    const prime = () => writeFileSync(path, 'ready')
    const priming = setInterval(prime, 25)
    try { await change('ready', prime) } finally { clearInterval(priming) }
    await change('ready hello', () => appendFileSync(path, ' hello'))
    expect(latest).toBe('ready hello')
    await change('replacement', () => { writeFileSync(join(root, 'new'), 'replacement'); renameSync(join(root, 'new'), path) })
    expect(latest).toBe('replacement')
    await change('truncated', () => writeFileSync(path, 'truncated'))
    expect(latest).toBe('truncated')
  } finally { close(); rmSync(root, { recursive: true, force: true }) }
})
