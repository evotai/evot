import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, deviceId } from '../../../src/features/remote/devices.js'
import { DeviceAccess, REQUEST_TTL } from '../../../src/features/remote/pairing.js'
import { GRANT_IDLE_TTL } from '../../../src/features/remote/devices.js'
import { testDevice } from '../../helpers/remote-device.js'

test('proving a pending device in two tabs reuses one TUI prompt, deadline and decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-pending-'))
  try {
    let now = 0, notifications = 0
    const access = new DeviceAccess(new DeviceStore(dir), () => { notifications++ }, () => now)
    const d = await testDevice()
    const prove = async () => {
      const { nonce } = access.challenge(d.key)!
      const result = access.prove(nonce, await d.sign(nonce))
      if (!result || !('receipt' in result)) throw Error('expected a pending approval')
      return result
    }
    const first = await prove()
    now += 4000
    const next = await prove()
    expect(notifications).toBe(1)
    expect(next.code).toBe(first.code)
    expect(next.receipt).not.toBe(first.receipt)
    expect(next.remainingMs).toBe(first.remainingMs - 4000)
    expect(access.decide(first.code, false)).toBe(true)
    expect(access.poll(first.receipt)).toBeNull()
    expect(access.poll(next.receipt)).toBeNull()
    const one = await prove(), two = await prove()
    expect(access.decide(two.code, true)).toBe(true)
    expect(access.poll(one.receipt)).toHaveProperty('token')
    expect(access.poll(two.receipt)).toHaveProperty('token')
    expect(access.poll(two.receipt)).toBeNull()
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('expired, denied, impersonated and replayed device proofs do not grant access; grants survive restart and revoke individually', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-device-'))
  let now = 1000
  try {
    const create = () =>
      new DeviceAccess(
        new DeviceStore(dir),
        () => {},
        () => now,
      )
    let a = create()
    const phone = await testDevice(),
      other = await testDevice()
    const enroll = async (d: typeof phone) => {
      const { nonce } = a.challenge(d.key)!
      return a.prove(nonce, await d.sign(nonce))
    }
    const nonce = a.challenge(phone.key)!.nonce
    expect(a.prove(nonce, await other.sign(nonce))).toBeNull()
    expect(a.prove(nonce, await phone.sign(nonce))).toBeNull()
    const expired = (await enroll(phone)) as { code: string; receipt: string }
    now += REQUEST_TTL
    expect(a.decide(expired.code, true)).toBe(false)
    const denied = (await enroll(phone)) as typeof expired
    expect(a.decide(denied.code, false)).toBe(true)
    expect(a.poll(denied.receipt)).toBeNull()
    for (const d of [phone, other]) {
      const p = (await enroll(d)) as typeof expired
      expect(a.decide(p.code, true)).toBe(true)
      expect(a.poll(p.receipt)).toHaveProperty('token')
      expect(a.poll(p.receipt)).toBeNull()
    }
    const f = join(dir, 'devices.json')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    expect(Object.keys(doc).sort()).toEqual(['devices', 'schema_version'])
    expect(doc.devices.every((d: object) => Object.keys(d).sort().join(',') === 'approvedAt,key,lastSeenAt')).toBe(true) // no address seen yet
    a = create()
    const token = ((await enroll(phone)) as { token: string }).token,
      token2 = ((await enroll(other)) as { token: string }).token
    // Idle grants expire: 29 days later the device still connects silently and the
    // visit refreshes its clock; after 30 idle days it is a new device again.
    now += GRANT_IDLE_TTL - 86_400_000
    const { nonce: n1 } = a.challenge(phone.key)!
    expect(a.prove(n1, await phone.sign(n1), '203.0.113.9')).toHaveProperty('token')
    expect(JSON.parse(readFileSync(f, 'utf8')).devices.find((d: { key: string }) => d.key === phone.key)).toMatchObject({lastSeenAt: now, lastSeenFrom: '203.0.113.9'})
    const { nonce: n2 } = a.challenge(phone.key)!
    expect(a.prove(n2, await phone.sign(n2), 'not an address')).toHaveProperty('token')
    expect(JSON.parse(readFileSync(f, 'utf8')).devices.find((d: { key: string }) => d.key === phone.key).lastSeenFrom).toBe('203.0.113.9')
    expect(a.store.list(now).find(d => d.id === deviceId(phone.key))?.lastSeenFrom).toBe('203.0.113.9')
    now += GRANT_IDLE_TTL - 1
    expect(await enroll(phone)).toHaveProperty('token')
    expect(a.authorized('Bearer ' + token2)).toBe(false) // other sat idle for 60 days
    const again = (await enroll(other)) as { code: string; receipt: string }
    expect(again).toHaveProperty('code')
    expect(a.decide(again.code, true)).toBe(true)
    const token3 = (a.poll(again.receipt) as { token: string }).token
    expect(JSON.parse(readFileSync(f, 'utf8')).devices.filter((d: { key: string }) => d.key === other.key)).toHaveLength(1)
    expect(a.store.list(now).map(d => d.expired)).toEqual([false, false])
    expect(a.revoke(deviceId(phone.key))).toBe(true)
    expect(a.authorized('Bearer ' + token)).toBe(false)
    expect(a.authorized('Bearer ' + token3)).toBe(true)
    a = create()
    expect(await enroll(phone)).toHaveProperty('code')
    expect(await enroll(other)).toHaveProperty('token')
    writeFileSync(f, JSON.stringify({ schema_version: 2, devices: [] }))
    expect(create).toThrow('Unsupported')
    writeFileSync(f, '{}')
    expect(create).toThrow('Invalid')
    writeFileSync(f, JSON.stringify({ devices: doc.devices.map(({ key, approvedAt }: { key: string; approvedAt: number }) => ({ key, approvedAt })) }))
    expect(create().store.list(now).map(d => [d.lastSeenAt === d.approvedAt, d.expired])).toEqual([[true, true], [true, true]])
    expect(create().store.has(phone.key, now)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
