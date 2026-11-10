import { describe, expect, test } from 'bun:test'
import { createJsonClient } from '../../../src/app/assets/console/ui/json-client.js'

describe('console JSON transport', () => {
  test('GET success balances activity hooks and decodes the body', async () => {
    const events: string[] = []
    const client = createJsonClient({
      begin: () => events.push('begin'), end: () => events.push('end'),
      fetchImpl: async (url: string, options: RequestInit) => {
        expect(url).toBe('/api/models')
        expect(options.headers).toEqual({ accept: 'application/json' })
        return Response.json({ models: [] })
      },
    })
    expect(await client.getJson('/api/models')).toEqual({ models: [] })
    expect(events).toEqual(['begin', 'end'])
  })

  test('POST preserves options and surfaces structured validation errors', async () => {
    const signal = new AbortController().signal
    let ends = 0
    const client = createJsonClient({
      end: () => ends++,
      fetchImpl: async (_url: string, options: RequestInit) => {
        expect(options.signal).toBe(signal)
        expect(options.method).toBe('POST')
        expect(options.body).toBe('{"model":"a"}')
        return Response.json({ ok: false, error: 'bad model' }, { status: 400 })
      },
    })
    await expect(client.postJson('/api/models', { model: 'a' }, { signal })).rejects.toThrow('bad model')
    expect(ends).toBe(1)
  })

  test('malformed bodies and network failures always finish activity', async () => {
    for (const method of ['getJson', 'postJson'] as const) {
      let ends = 0
      const client = createJsonClient({ end: () => ends++, fetchImpl: async () => { throw new Error('offline') } })
      await expect(client[method]('/api', {})).rejects.toThrow('offline')
      expect(ends).toBe(1)
    }
    const client = createJsonClient({ fetchImpl: async () => new Response('not JSON') })
    await expect(client.getJson('/api')).rejects.toThrow()
    expect(await client.postJson('/api', {})).toBeNull()
  })

  test('application error in HTTP 200 is still an error; empty error response uses status', async () => {
    const invalid = createJsonClient({ fetchImpl: async () => Response.json({ ok: false, error: 'rejected' }) })
    await expect(invalid.postJson('/api', {})).rejects.toThrow('rejected')
    const unavailable = createJsonClient({ fetchImpl: async () => new Response('', { status: 503 }) })
    await expect(unavailable.postJson('/api', {})).rejects.toThrow('HTTP 503')
  })
})
