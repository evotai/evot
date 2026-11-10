import { expect, test } from 'bun:test'
import { isSlashCommand } from '../../src/commands/index.js'
import shapes from '../fixtures/contracts/command-shapes.json'
import { isQueuedCommand, requestSteering } from '../../../src/app/assets/console/ui/chat-control.js'

test('TUI and Web use the same command boundary without swallowing paths', () => {
  for (const fixture of shapes) {
    expect(isSlashCommand(fixture.text)).toBe(fixture.command)
    expect(isQueuedCommand(fixture.text)).toBe(fixture.command)
  }
})

test('only explicit inactive response permits resubmission', async () => {
  const calls: unknown[] = []
  const post = async (url: string, body: unknown) => { calls.push([url, body]); return { active: false } }
  expect(await requestSteering(post, null, 'draft')).toEqual({ status: 'inactive' })
  expect(calls).toHaveLength(0)
  expect(await requestSteering(post, 'session', 'draft')).toEqual({ status: 'inactive' })
  expect(calls).toEqual([['/api/chat/steer', { session_id: 'session', message: 'draft' }]])
  expect(await requestSteering(async () => ({ active: true }), 's', 'draft')).toEqual({ status: 'queued' })
})

test('failed or malformed responses retain uncertainty and never retry', async () => {
  for (const value of [null, {}, { active: 'no' }]) {
    let calls = 0
    expect((await requestSteering(async () => { calls++; return value }, 's', 'draft')).status).toBe('uncertain')
    expect(calls).toBe(1)
  }
  expect(await requestSteering(async () => { throw new Error('offline') }, 's', 'draft')).toEqual({ status: 'uncertain', error: 'offline' })
})

test('console serves the transport and keeps unconfirmed text copyable', async () => {
  const source = await Bun.file(new URL('../../../src/app/assets/console/ui/chat.js', import.meta.url)).text()
  expect(source).toContain('requestSteering(postJson, sessionId, text)')
  expect(source).toContain('Delivery unconfirmed · copy to retry')
  const assets = await Bun.file(new URL('../../../src/app/src/surface/gateway/channels/http/assets.rs', import.meta.url)).text()
  expect(assets).toContain('"/ui/chat-control.js"')
})
