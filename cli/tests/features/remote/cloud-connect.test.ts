import { expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectInviteUrl, ticketGate } from '../../../src/features/remote/cloud-connect.js'
import { machineIdentity } from '../../../src/features/remote/machine-identity.js'
import { DeviceStore, deviceId } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'
import { testDevice } from '../../helpers/remote-device.js'

test('a machine identity persists without an account, differs on a fresh install, and refuses a copied identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-machine-'))
  const other = mkdtempSync(join(tmpdir(), 'evot-machine-'))
  const fixture = () => 'linux:1234'
  try {
    expect(() => machineIdentity(home, false, fixture)).toThrow()
    const original = machineIdentity(home, true, fixture)
    expect(machineIdentity(home, true, fixture)).toEqual(original)
    expect(machineIdentity(other, true, () => 'linux:4321').environment).not.toBe(original.environment)
    const path = '.evotai/remote/machine.json'
    copyFileSync(join(home, path), join(other, path))
    expect(() => machineIdentity(other, true, () => 'linux:4321')).toThrow('belongs to another machine')
    expect(machineIdentity(other, false, fixture)).toEqual(original) // full clones with the same platform ID look alike
  } finally {
    for (const dir of [home, other]) rmSync(dir, { recursive: true, force: true })
  }
})

test('QR links select a computer, never carry login credentials, and respect custom account servers', () => {
  const id = '1'.repeat(32)
  expect(connectInviteUrl('https://auto.evot.ai', id)).toBe(`https://connect.evot.ai/${id}`)
  expect(connectInviteUrl('https://self.example', id)).toBe(`https://self.example/connect?env=${id}`)
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
    { cloud: { unix, origin, admit: gate, login: () => 'https://account.example/connect', renewal: {endpoint:'https://account.example/connect/renew', env} } },
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
    const initial = await post(route, { key })
    expect(initial.headers.get('content-security-policy')).toContain("connect-src 'self' https://account.example/connect/renew;")
    expect(await initial.json()).toEqual({login:'https://account.example/connect', renew:`https://account.example/connect/renew?env=${env}&key=${key}`})
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
    expect(access.approve(code)).toBe(true)
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
