import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messagePhotos } from '../../../src/features/remote/phone-photo-preview.js'
import legacyPhoto from '../../fixtures/contracts/remote-photo-legacy.json'
import { parseRemoteAction, REMOTE_IMAGE_LIMITS } from '../../../src/features/remote/protocol.js'
import { DeviceStore } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'
import { PHOTO_EXPIRED, PhotoStash } from '../../../src/features/remote/photo-stash.js'
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

test('photo receipts associate only the submitting tab’s local blobs with confirmed rows; old rows remain text', async () => {
  const draftId = crypto.randomUUID()
  expect(parseRemoteAction({kind:'send', generation:0, text:'', images:[photo()], draftId})).toMatchObject({draftId})
  const messages = [legacyPhoto.message, {...legacyPhoto.message, photoId:draftId}]
  expect(parseRemoteAction(legacyPhoto.action)).toEqual(legacyPhoto.action)
  const cached = messagePhotos(), blob = new Blob(['photo']), url = URL.createObjectURL(blob)
  try {
    cached.remember(draftId,[{url,blob}]); cached.prune(messages)
    expect(cached.get(undefined)).toBeUndefined()
    expect(await (await fetch(cached.get(draftId)[0].url)).text()).toBe('photo')
    cached.prune([]); expect(cached.get(draftId)).toBeUndefined(); await expect(fetch(url)).rejects.toThrow()
  } finally { URL.revokeObjectURL(url) }
})

test('only /action takes a photo-sized body; enrollment and other routes keep the small limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-images-'))
  const received: unknown[] = []
  let code = ''
  const access = new DeviceAccess(new DeviceStore(dir), c => { code = c })
  const l = listenRemote({ snapshot() { throw Error('unused') }, act(a) { received.push(a) } }, access)
  try {
    const pending = await pendingDevice(l.address)
    access.approve(code)
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

test('a photo uploaded while typing travels by id; the window still receives ordinary inline images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-photo-stash-'))
  const received: unknown[] = []
  let code = ''
  const access = new DeviceAccess(new DeviceStore(dir), c => { code = c })
  const l = listenRemote({ snapshot() { throw Error('unused') }, act(a) { received.push(a) } }, access)
  try {
    const pair = async () => { const pending = await pendingDevice(l.address); access.approve(code); return 'Bearer ' + (await pending.poll()).token }
    const auth = await pair(), other = await pair()
    const post = (path: string, body: unknown, authorization = auth) => fetch(l.address + path, { method: 'POST', body: JSON.stringify(body),
      headers: { origin: l.address, 'content-type': 'application/json', authorization } })
    const big = photo('A'.repeat(2 * 1024 * 1024))
    const upload = await post('/photos', big)
    expect(upload.status).toBe(200)
    const { id } = await upload.json() as { id: string }
    // Another approved browser cannot use, or even probe, this device's upload.
    expect((await post('/action', { kind: 'send', generation: 1, text: 'look', images: [{ ref: id }] }, other)).status).toBe(412)
    expect(received).toEqual([])
    expect((await post('/action', { kind: 'send', generation: 1, text: 'look', images: [{ ref: id }] })).status).toBe(204)
    expect(received).toEqual([{ kind: 'send', generation: 1, text: 'look', images: [big] }])
    // Used once: a replay gets the resend signal, which the phone answers with inline bytes.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const binary = (bytes: Uint8Array, origin = l.address, authorization = auth) => fetch(l.address + '/photos', {
      method: 'POST', body: new Blob([new Uint8Array(bytes)]), headers: { origin, authorization, 'content-type': 'image/jpeg' } })
    expect((await binary(jpeg, 'https://other.invalid')).status).toBe(403)
    expect((await binary(jpeg, l.address, 'Bearer invalid')).status).toBe(401)
    expect((await binary(new Uint8Array(3))).status).toBe(400)
    const raw = await binary(jpeg)
    expect(raw.status).toBe(200)
    const ref = (await raw.json() as {id: string}).id
    expect((await post('/action', { kind:'send', generation:1, text:'binary', images:[{ref}] })).status).toBe(204)
    expect(received.at(-1)).toMatchObject({ images:[photo(Buffer.from(jpeg).toString('base64'))] })
    const replay = await post('/action', { kind: 'send', generation: 1, text: 'look', images: [{ ref: id }] })
    expect([replay.status, await replay.text()]).toEqual([412, PHOTO_EXPIRED])
    expect((await post('/photos', { mimeType: 'image/svg+xml', data: 'QUJD' })).status).toBe(400)
    expect((await post('/photos', photo('A'.repeat(REMOTE_IMAGE_LIMITS.base64Each + 4)))).status).toBe(400) // one photo's limit
    expect((await post('/photos', photo('A'.repeat(REMOTE_IMAGE_LIMITS.base64Each + 128 * 1024)))).status).toBe(413) // never buffered whole
    expect((await post('/photos', big, 'Bearer nope')).status).toBe(401)
  } finally { l.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('uploads expire, stay bounded per device and never resolve another device’s id', () => {
  let now = 0
  const stash = new PhotoStash(() => now)
  const ids = Array.from({ length: REMOTE_IMAGE_LIMITS.count * 2 + 1 }, () => stash.put('a', photo()))
  expect(stash.size).toBe(REMOTE_IMAGE_LIMITS.count * 2) // the oldest made room
  expect(stash.resolve('a', { images: [{ ref: ids[0] }] })).toBeNull()
  expect(stash.resolve('a', { images: [{ ref: ids.at(-1) }, photo('QkJC')] })).toMatchObject({ body: { images: [photo(), photo('QkJC')] }, refs: [ids.at(-1)] })
  expect(stash.resolve('b', { images: [{ ref: ids.at(-1) }] })).toBeNull()
  const large = Array.from({ length: 3 }, () => stash.put('c', photo('A'.repeat(REMOTE_IMAGE_LIMITS.base64Each - 4))))
  expect(stash.resolve('c', { images: [{ ref: large[0] }] })).toBeNull() // total bytes stay bounded too
  now += 10 * 60_000
  expect(stash.resolve('a', { images: [{ ref: ids.at(-1) }] })).toBeNull()
  expect(stash.resolve('a', { kind: 'send', text: 'plain' })).toEqual({ body: { kind: 'send', text: 'plain' }, refs: [] })
})
