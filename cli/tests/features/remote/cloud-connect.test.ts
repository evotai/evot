import { expect, test } from 'bun:test'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharedConnectInvite, ticketGate } from '../../../src/features/remote/cloud-connect.js'
import { DeviceStore, deviceId } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'
import { testDevice } from '../../helpers/remote-device.js'

test('QR links select a Mac, never carry login credentials, and respect custom account servers', () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-invite-'))
  try {
    const dir = join(home, 'remote', 'profile'), secret = randomBytes(32).toString('base64url')
    const id = createHash('sha256').update(`owner:${secret}`).digest('hex').slice(0, 32)
    const invite = (base: string) => sharedConnectInvite(home, 'profile', JSON.stringify([base, 'owner']))
    mkdirSync(dir, { recursive: true })
    expect(() => invite('https://auto.evot.ai')).toThrow() // must not allocate from a sibling
    writeFileSync(join(dir, 'host.key'), secret, { mode: 0o600 })
    expect(invite('https://auto.evot.ai')).toBe(`https://connect.evot.ai/${id}`)
    expect(invite('https://self.example')).toBe(`https://self.example/connect?env=${id}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('managed Unix ingress requires exact public origin, an account ticket, device possession AND local approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-cloud-')),
    unix = join(dir, 'g.sock'),
    origin = 'https://environment.example',
    env = 'a'.repeat(32)
  const material = randomBytes(32),
    gate = ticketGate(env, material.toString('base64url')),
    phone = await testDevice()
  const sign = (environment = env, sec = 90) => {
    const msg = Buffer.from(
      JSON.stringify({
        env: environment,
        key: phone.key,
        nonce: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + sec,
      }),
    ).toString('base64url')
    return msg + '.' + createHmac('sha256', material).update(msg).digest('base64url')
  }
  let code = '',
    actions = 0
  const access = new DeviceAccess(new DeviceStore(dir), (value) => {
    code = value
  })
  const gateway = listenRemote(
    {
      snapshot() {
        throw Error('unused')
      },
      act() {
        actions++
      },
    },
    access,
    { cloud: { unix, origin, admit: gate, login: () => 'https://account.example/connect' } },
  )
  const post = (path: string, data: unknown, token = '', host = 'environment.example') =>
    fetch('http://localhost' + path, {
      unix,
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(data),
    })
  try {
    const route = '/device/challenge',
      key = phone.key
    expect(await (await post(route, { key })).json()).toHaveProperty('login')
    for (const ticket of [sign('another'), sign(env, -1), 'invalid'])
      expect((await post(route, { key, ticket })).status).toBe(403)
    const ticket = sign()
    expect((await post(route, { key, ticket }, '', 'wrong.example')).status).toBe(403)
    const { nonce } = (await (await post(route, { key, ticket })).json()) as { nonce: string }
    expect(nonce).toBeString()
    expect((await post(route, { key, ticket })).status).toBe(403)
    const { receipt } = (await (await post('/device/prove', { nonce, signature: await phone.sign(nonce) })).json()) as {
      receipt: string
    }
    expect(await (await post('/device/poll', { receipt })).json()).toEqual({ pending: true })
    expect((await post('/action', {})).status).toBe(401)
    expect(access.decide(code, true)).toBe(true)
    const { token } = (await (await post('/device/poll', { receipt })).json()) as { token: string }
    expect((await post('/action', { kind: 'stop', generation: 1 }, token)).status).toBe(204)
    expect(actions).toBe(1)
    access.revoke(deviceId(key))
    expect((await post('/action', { kind: 'stop', generation: 1 }, token)).status).toBe(401)
  } finally {
    gateway.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
