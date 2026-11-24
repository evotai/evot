import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, deviceId } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { privateSocketDirectory } from '../../../src/features/remote/discovery.js'
import { grantHandler, manageGrants } from '../../../src/features/remote/grants.js'
import { leasePath, tryGatewayLease } from '../../../src/features/remote/lease.js'
import { testDevice } from '../../helpers/remote-device.js'

test('an older or unreachable live owner never falls back to an offline write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-old-owner-')), scope = 'f'.repeat(24)
  const path = leasePath(home, scope), dir = privateSocketDirectory(home)
  const old = createServer(socket => socket.destroy())
  try {
    await new Promise<void>((ok, fail) => old.once('error', fail).listen(path, ok))
    const store = new DeviceStore(join(home, 'remote', scope)), device = await testDevice()
    store.approve(device.key)
    await expect(manageGrants(home, scope, deviceId(device.key), () => true)).rejects.toThrow('gateway TUI')
    expect(new DeviceStore(join(home, 'remote', scope)).has(device.key)).toBe(true)
  } finally {
    old.close(); rmSync(home, { recursive:true, force:true }); rmSync(dir, { recursive:true, force:true })
  }
})

test('sibling revokes through the live owner; offline revoke never enables sharing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-grants-')), scope = 'a'.repeat(24)
  const socketDir = privateSocketDirectory(home), path = leasePath(home, scope)
  const store = () => new DeviceStore(join(home, 'remote', scope))
  let release: (() => void) | null = null
  try {
    const device = await testDevice(), id = deviceId(device.key), ready = () => true
    const access = new DeviceAccess(store(), () => {})
    access.store.approve(device.key)
    const { nonce } = access.challenge(device.key)!
    const proof = access.prove(nonce, await device.sign(nonce))
    if (!proof || !('token' in proof)) throw Error('fixture grant missing')
    const bearer = 'Bearer ' + proof.token
    release = await tryGatewayLease(path, grantHandler(() => access))
    if (!release) throw Error('fixture lease missing')
    expect(await tryGatewayLease(path)).toBeNull()
    const list = await manageGrants(home, scope, undefined, ready)
    expect(list).toContain(`/remote revoke ${id}`)
    expect(list).not.toContain(device.key)
    expect(await manageGrants(home, 'b'.repeat(24), undefined, ready)).toBe('No approved devices.')
    await expect(manageGrants(home, scope, id, () => false)).rejects.toThrow('profile changed')
    expect(access.authorized(bearer)).toBe(true)
    expect((await fetch('http://localhost/device/approve', { unix: path, method:'POST' })).status).toBe(403)
    expect(await manageGrants(home, scope, id, ready)).toBe('Device revoked.')
    expect(access.authorized(bearer)).toBe(false)
    expect(store().has(device.key)).toBe(false)
    release(); release = null
    store().approve(device.key)
    expect(await manageGrants(home, scope, id, ready)).toBe('Device revoked.')
    expect(store().has(device.key)).toBe(false)
    // revoke all: through the live owner it also ends current phone sessions; offline it clears the file.
    const other = await testDevice()
    access.store.approve(device.key); access.store.approve(other.key)
    const { nonce: n } = access.challenge(device.key)!, again = access.prove(n, await device.sign(n), '198.51.100.7')
    if (!again || !('token' in again)) throw Error('fixture grant missing')
    release = await tryGatewayLease(path, grantHandler(() => access))
    expect(await manageGrants(home, scope, undefined, ready)).toMatch(/last connected \d{4}-\d\d-\d\d \d\d:\d\d from 198\.51\.100\.7/)
    await expect(manageGrants(home, scope, 'ALL', ready)).rejects.toThrow('revoke all')
    expect(await manageGrants(home, scope, 'all', ready)).toBe('Revoked 2 devices. Every phone must be approved again.')
    expect(access.authorized('Bearer ' + again.token)).toBe(false)
    expect(store().list()).toEqual([])
    release(); release = null
    store().approve(other.key)
    expect(await manageGrants(home, scope, 'all', ready)).toBe('Revoked 1 device. Every phone must be approved again.')
    expect(await manageGrants(home, scope, 'all', ready)).toBe('No approved devices.')
  } finally {
    release?.(); rmSync(home, {recursive:true, force:true}); rmSync(socketDir, {recursive:true, force:true})
  }
})
