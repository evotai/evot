import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRemoteAction, REMOTE_IMAGE_LIMITS } from '../../../src/features/remote/protocol.js'
import { DeviceStore } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'
import { pendingDevice } from '../../helpers/remote-device.js'

const photo = (data = 'QUJD') => ({ mimeType: 'image/jpeg', data })

test('a phone message may carry up to four bounded photos of the image types models accept', () => {
  expect(parseRemoteAction({ kind: 'send', generation: 1, text: 'look', images: [photo()] })).toEqual({ kind: 'send', generation: 1, text: 'look', images: [photo()] })
  expect(parseRemoteAction({ kind: 'send', generation: 1, text: '', images: [photo()] })).toMatchObject({ text: '', images: [photo()] })
  expect(parseRemoteAction({ kind: 'steer', generation: 1, text: 'no photos' })).toEqual({ kind: 'steer', generation: 1, text: 'no photos' })
  for (const images of [
    Array(REMOTE_IMAGE_LIMITS.count + 1).fill(photo()),
    [{ mimeType: 'image/svg+xml', data: 'QUJD' }],
    [{ mimeType: 'image/jpeg', data: 'not base64!' }],
    [photo('A'.repeat(REMOTE_IMAGE_LIMITS.base64Each + 4))],
    Array(3).fill(photo('A'.repeat(REMOTE_IMAGE_LIMITS.base64Each - 4))),
    'QUJD',
  ]) expect(parseRemoteAction({ kind: 'send', generation: 1, text: 'x', images })).toBeNull()
  expect(parseRemoteAction({ kind: 'send', generation: 1, text: '' })).toBeNull()
})

test('only /action takes a photo-sized body; enrollment and other routes keep the small limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-images-'))
  const received: unknown[] = []
  let code = ''
  const access = new DeviceAccess(new DeviceStore(dir), c => { code = c })
  const l = listenRemote({ snapshot() { throw Error('unused') }, act(a) { received.push(a) } }, access)
  try {
    const pending = await pendingDevice(l.address)
    access.decide(code, true)
    const auth = 'Bearer ' + (await pending.poll()).token
    const post = (path: string, body: string) => fetch(l.address + path, { method: 'POST', body,
      headers: { origin: l.address, 'content-type': 'application/json', authorization: auth } })
    const big = photo('A'.repeat(2 * 1024 * 1024))
    expect((await post('/action', JSON.stringify({ kind: 'send', generation: 1, text: 'look', images: [big] }))).status).toBe(204)
    expect(received).toHaveLength(1)
    expect((await post('/device/challenge', JSON.stringify({ key: 'x'.repeat(200 * 1024) }))).status).toBe(413)
    expect((await post('/open', JSON.stringify({ pad: 'x'.repeat(200 * 1024) }))).status).toBe(413)
  } finally { l.close(); rmSync(dir, { recursive: true, force: true }) }
})
