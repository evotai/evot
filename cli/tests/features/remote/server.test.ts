import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, deviceId } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'
import { pendingDevice, testDevice } from '../../helpers/remote-device.js'
import { parseRemoteAction, type RemoteSnapshot } from '../../../src/features/remote/protocol.js'

test('remote task actions are semantic intents with a generation, not arbitrary key events', () => {
  const target = 'f'.repeat(64)
  const draftId = crypto.randomUUID()
  for (const cmd of [{kind:'queue', text:'later', draftId}, {kind:'suggest'}, {kind:'cycle-effort',revision:'r'}, {kind:'pull-draft', draftId}, {kind:'steer', text:'hi', draftId}, {kind:'stop', askId:'a'}, {kind:'cancel-ask', id:'ask-a'}, {kind:'interrupt-ask', id:'ask-b'}, {kind:'stop-background', target}]) {
    expect(parseRemoteAction({...cmd, generation:7})).toEqual({...cmd, generation:7})
    expect(parseRemoteAction(cmd)).toBeNull()
  }
  for (const cmd of [{kind:'cancel-ask'}, {kind:'cancel-ask', id:''}, {kind:'stop-background'}, {kind:'stop-background', target:'all'}, {kind:'pull-draft'}, {kind:'cycle-effort'}, {kind:'steer', text:'hi', draftId:9}, {kind:'background-shell'}, {kind:'release-wait'}, {kind:'keypress', key:'Ctrl+B'}])
    expect(parseRemoteAction({...cmd, generation:7})).toBeNull()
})

test('only authorized Sessions and chat traffic count, once per device; revoking clears it immediately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-presence-'))
  let changes = 0
  const access = new DeviceAccess(new DeviceStore(dir), () => {}, { presenceChanged: () => { changes++ } })
  const view: RemoteSnapshot = {
    models: { active: 'fixture', effort: '', pending: null, revision: '0', options: [] },
    sessionId: null, generation: 1, status: '', messages: [], live: '', input: 'send', canStop: false, ask: null,
  }
  const gateway = listenRemote({ snapshot: () => view, act() {} }, access)
  async function credential(device: Awaited<ReturnType<typeof testDevice>>) {
    const { nonce } = access.challenge(device.key)!
    const proof = await access.prove(nonce, await device.sign(nonce))
    if (!proof || !('token' in proof)) throw Error('Expected an approved test device.')
    return 'Bearer ' + proof.token
  }
  const phone = 'Mozilla/5.0 (iPhone) Mobile/15E148', desktop = 'Mozilla/5.0 (Windows NT 10.0)'
  const get = (path: string, authorization: string, userAgent: string, accept = 'application/json') =>
    fetch(gateway.address + path, { headers: { authorization, 'user-agent': userAgent, accept } })
  try {
    const a = await testDevice(), b = await testDevice()
    for (const device of [a, b]) access.store.approve(device.key)
    const first = await credential(a), second = await credential(a), other = await credential(b)
    expect((await get('/sessions?catalog=1', 'Bearer unapproved', phone)).status).toBe(401)
    expect(changes).toBe(0) // having an approved key or token is not the same as being online
    const catalog = await get('/sessions?catalog=1', first, phone)
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).not.toHaveProperty('onlineDevices')
    expect((await get('/sessions?online', second, phone)).status).toBe(200)
    expect(access.onlineDevices).toEqual({ phone: 1, tablet: 0, desktop: 0, unknown: 0 })
    expect(changes).toBe(1)

    const stream = await get('/state', other, desktop, 'text/event-stream')
    expect(stream.headers.get('content-type')).toBe('text/event-stream')
    const reader = stream.body!.getReader()
    try {
      const firstFrame = new TextDecoder().decode((await reader.read()).value)
      expect(firstFrame).toContain('data: {"view":')
      expect(firstFrame).not.toContain('onlineDevices')
      expect(access.onlineDevices).toEqual({ phone: 1, tablet: 0, desktop: 1, unknown: 0 })
      expect(access.revoke(deviceId(a.key))).toBe(true)
      expect((await get('/sessions', first, phone)).status).toBe(401)
      expect(access.onlineDevices).toEqual({ phone: 0, tablet: 0, desktop: 1, unknown: 0 })
      expect(changes).toBe(3)
    } finally { await reader.cancel() }
    gateway.close()
    expect(access.onlineDevices).toEqual({ phone: 0, tablet: 0, desktop: 0, unknown: 0 })
  } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }) }
})

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
    access.approve(notice)
    const auth = 'Bearer ' + (await pending.poll()).token
    const catalog = await fetch(l.address + '/sessions?catalog=1', {headers:{authorization:auth}})
    expect(catalog.status).toBe(200)
    expect(catalog.headers.get('X-Evot-Time-Zone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    // A strict reader of the previous JSON contract still sees the same fields.
    expect(await catalog.json()).toStrictEqual({
      count:0, more:false, rows:[], online:[], privateWindows:[], unavailable:false, failed:false,
    })
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
