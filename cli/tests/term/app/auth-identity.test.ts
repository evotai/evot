import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AuthIdentityTracker, readAuthIdentity } from '../../../src/term/app/auth/auth-identity.js'

const auth = (id = 'user-a', server = 'https://cloud.example') => ({
  user: { id }, server_base_url: server, cli_token: 'test-token', models_synced_at: 1,
})

test('catalog sync and token rotation are not identity transitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-identity-'))
  try {
    const path = join(root, 'auth.json')
    writeFileSync(path, JSON.stringify(auth()))
    let changes = 0
    const tracker = new AuthIdentityTracker(() => { changes++ }, root)
    writeFileSync(join(root, 'models.cache.json'), '{"revision":2}')
    tracker.refresh()
    writeFileSync(path, JSON.stringify({ ...auth(), cli_token: 'rotated-test-token', models_synced_at: 2 }))
    tracker.refresh()
    writeFileSync(path, JSON.stringify(auth('user-a', 'https://cloud.example/')))
    tracker.refresh()
    expect(changes).toBe(0)
    writeFileSync(path, JSON.stringify(auth('user-b')))
    tracker.refresh()
    expect(changes).toBe(1)
    writeFileSync(path, JSON.stringify(auth('user-b', 'https://other.example')))
    tracker.refresh()
    expect(changes).toBe(2)
    rmSync(path)
    tracker.refresh()
    expect(changes).toBe(3)
    tracker.refresh()
    expect(changes).toBe(3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('invalid auth reads do not masquerade as logout or consume the last identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-identity-'))
  try {
    const path = join(root, 'auth.json')
    writeFileSync(path, JSON.stringify(auth()))
    let changes = 0
    const tracker = new AuthIdentityTracker(() => { changes++ }, root)
    for (const raw of ['{', '{}', 'null']) {
      writeFileSync(path, raw)
      expect(readAuthIdentity(root)).toBeUndefined()
      tracker.refresh()
    }
    writeFileSync(path, JSON.stringify(auth()))
    tracker.refresh()
    expect(changes).toBe(0)
    writeFileSync(path, JSON.stringify(auth('user-b')))
    tracker.refresh()
    expect(changes).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
