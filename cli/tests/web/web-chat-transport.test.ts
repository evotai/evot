import { describe, expect, test } from 'bun:test'
import { streamChat } from '../../../src/app/assets/console/ui/chat-transport.js'

function response(text: string, split: number) {
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split))
      controller.enqueue(bytes.slice(split))
      controller.close()
    },
  })
  return new Response(body)
}

describe('Web chat transport', () => {
  test('handles every byte boundary, CRLF, keepalive and final unterminated data', async () => {
    const text = ': ping\r\ndata: {"text":"你好🙂"}\r\n\r\ndata: invalid\ndata: {"type":"done"}'
    for (let split = 0; split <= new TextEncoder().encode(text).length; split++) {
      const nodes: unknown[] = []
      const reply = response(text, split)
      await streamChat({}, { onNode: (node: unknown) => nodes.push(node), fetchImpl: async () => reply })
      expect(nodes).toEqual([{ text: '你好🙂' }, { type: 'done' }])
      expect(reply.body?.locked).toBe(false)
    }
  })

  test('forwards payload and cancellation signal without owning UI state', async () => {
    const controller = new AbortController()
    const payload = { message: 'hi', provider: 'test', model: 'test-model' }
    await streamChat(payload, {
      signal: controller.signal,
      onNode: () => {},
      fetchImpl: async (url: string, options: RequestInit) => {
        expect(url).toBe('/api/chat')
        expect(options.signal).toBe(controller.signal)
        expect(JSON.parse(String(options.body))).toEqual(payload)
        return response('', 0)
      },
    })
  })

  test('HTTP failure and consumer errors propagate without leaking reader locks', async () => {
    await expect(streamChat({}, { onNode: () => {}, fetchImpl: async () => new Response('', { status: 503 }) })).rejects.toThrow('Chat request failed (503)')
    const reply = response('data: {}\n', 0)
    await expect(streamChat({}, {
      onNode: () => { throw new Error('consumer failed') }, fetchImpl: async () => reply,
    })).rejects.toThrow('consumer failed')
    expect(reply.body?.locked).toBe(false)
  })

  test('consumer failure cancels a still-open response body', async () => {
    let cancelled = false
    const reply = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n')) },
      cancel() { cancelled = true },
    }))
    await expect(streamChat({}, {
      onNode: () => { throw new Error('render failed') }, fetchImpl: async () => reply,
    })).rejects.toThrow('render failed')
    expect(cancelled).toBe(true)
    expect(reply.body?.locked).toBe(false)
  })

  test('abort propagates from the injected HTTP client', async () => {
    const failure = new DOMException('aborted', 'AbortError')
    await expect(streamChat({}, { onNode: () => {}, fetchImpl: async () => { throw failure } })).rejects.toBe(failure)
  })
})
