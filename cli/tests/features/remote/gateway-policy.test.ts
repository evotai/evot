import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayPolicy, updateGatewayPolicy } from '../../../src/features/remote/gateway-policy.js'
import { privateSocketDirectory } from '../../../src/features/remote/socket-directory.js'
import legacy from '../../fixtures/contracts/remote-gateway-policy-v0.json'

test('read the versionless machine preference and keep the scope contract readable after explicit shutdown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-remote-policy-')), dir = join(home, 'remote'), path = join(dir, 'gateway.json')
  try {
    expect(gatewayPolicy(home)).toBeUndefined()
    mkdirSync(dir)
    writeFileSync(path, JSON.stringify(legacy), { mode: 0o600 })
    expect(gatewayPolicy(home)).toBe(legacy.scope)
    expect(await updateGatewayPolicy(home, legacy.scope, 'disable', () => true)).toBe(false)
    const { schema_version, ...oldFields } = JSON.parse(readFileSync(path, 'utf8'))
    expect(schema_version).toBe(1)
    expect(oldFields).toEqual({ scope: null })
    expect(await updateGatewayPolicy(home, legacy.scope, 'adopt', () => true)).toBe(false)
    expect(gatewayPolicy(home)).toBeNull()

    writeFileSync(path, JSON.stringify({ schema_version:2, ...legacy }))
    expect(() => gatewayPolicy(home)).toThrow('Unsupported Remote gateway settings version.')
    await expect(updateGatewayPolicy(home, legacy.scope, 'enable', () => true)).rejects.toThrow('Unsupported Remote gateway settings version.')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schema_version:2, ...legacy })
  } finally {
    rmSync(privateSocketDirectory(home), { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('simultaneous opt-ins never replace the selected profile or persist a stale login', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-remote-policy-race-')), a = legacy.scope, b = 'b'.repeat(24)
  try {
    await expect(updateGatewayPolicy(home, a, 'enable', () => false)).rejects.toThrow('The active profile changed')
    expect(gatewayPolicy(home)).toBeUndefined()
    const results = await Promise.allSettled([a,b].map(scope => updateGatewayPolicy(home, scope, 'enable', () => true)))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const selected = gatewayPolicy(home)
    expect(selected).toBe(results[0]?.status === 'fulfilled' ? a : b)
    const other = selected === a ? b : a
    await expect(updateGatewayPolicy(home, other, 'disable', () => true)).rejects.toThrow('different profile')
    expect(gatewayPolicy(home)).toBe(selected)
  } finally {
    rmSync(privateSocketDirectory(home), { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
