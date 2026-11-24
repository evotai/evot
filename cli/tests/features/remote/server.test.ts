import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, deviceId } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'
import { pendingDevice } from '../../helpers/remote-device.js'
import { parseRemoteAction } from '../../../src/features/remote/protocol.js'

test('only loopback, same-origin, locally approved devices can use the gateway; revocation closes current sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-device-'))
  let count = 0,
    notice = ''
  const access = new DeviceAccess(new DeviceStore(dir), (code) => {
    notice = code
  })
  const l = listenRemote(
    {
      snapshot() {
        throw Error('unexpected')
      },
      act() {
        count++
      },
    },
    access,
  )
  const post = (path: string, body: unknown, auth = '', origin = l.address) =>
    fetch(l.address + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    })
  try {
    expect(new URL(l.address).hostname).toBe('127.0.0.1')
    for (const url of ['/state', '/sessions']) expect((await fetch(l.address + url)).status).toBe(401)
    expect((await post('/open', {})).status).toBe(401)
    expect((await post('/pair', { code: '12345678' })).status).toBe(404)
    const pending = await pendingDevice(l.address)
    expect(notice).toBe(pending.code)
    expect(await pending.poll()).toEqual({ pending: true })
    expect((await post('/device/approve', { code: notice })).status).toBe(404)
    access.decide(notice, true)
    const auth = 'Bearer ' + (await pending.poll()).token
    expect((await post('/action', { kind: 'stop', generation: 1 }, auth, 'https://example.org')).status).toBe(403)
    expect((await post('/action', { kind: 'stop', generation: 1 }, auth)).status).toBe(204)
    expect(count).toBe(1)
    expect(access.revoke(deviceId(pending.key))).toBe(true)
    expect((await post('/action', { kind: 'stop', generation: 1 }, auth)).status).toBe(401)
    expect((await fetch(l.address + '/sessions', { headers: { authorization: auth } })).status).toBe(401)
    for (const action of [
      { kind: 'approve', generation: 1 },
      { kind: 'send', generation: 1, text: 'a\x1b[0m' },
    ])
      expect(parseRemoteAction(action)).toBeNull()
  } finally {
    l.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
