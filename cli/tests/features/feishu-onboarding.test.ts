import { expect, test } from 'bun:test'
import { setupFeishu, type SetupState } from '../../src/features/channels/feishu/onboarding.js'
import { waitForSetup } from '../../src/features/channels/setup-wait.js'

const empty: SetupState = {
  configured: false, revision: '', default_chat_id: '', chats: [],
  connection: { state: 'connecting', message: '' },
}

test('configuration, connection and explicit chat confirmation complete setup', async () => {
  let state = structuredClone(empty)
  const messages: string[] = []
  const bindings: string[] = []
  const result = await setupFeishu({
    consoleUrl: 'http://127.0.0.1:8082/feishu', signal: new AbortController().signal,
    observe: async () => structuredClone(state),
    wait: async (message, check) => {
      messages.push(message)
      if (!state.configured) state = { ...state, configured: true, revision: 'v1', connection: { state: 'connected', message: '' } }
      else state.chats = ['oc_mine']
      return check()
    },
    ask: async questions => [{ header: '', question: questions[0]!.question, answer: 'oc_mine' }],
    bind: async (revision, chat) => { bindings.push(`${revision}:${chat}`) },
  })
  expect(result).toBe(true)
  expect(messages[0]).toContain('http://127.0.0.1:8082/feishu')
  expect(messages[1]).toContain('private message')
  expect(bindings).toEqual(['v1:oc_mine'])
})

test('a remembered chat is never adopted without confirmation', async () => {
  let bound = false
  const result = await setupFeishu({
    consoleUrl: 'http://localhost/feishu', signal: new AbortController().signal,
    observe: async () => ({ ...empty, configured: true, chats: ['oc_existing'], connection: { state: 'connected', message: '' } }),
    wait: async () => { throw new Error('should ask instead') },
    ask: async () => null,
    bind: async () => { bound = true },
  })
  expect(result).toBe(false)
  expect(bound).toBe(false)
})

test('failed credentials remain in setup until changed, never fall back to local', async () => {
  const result = await setupFeishu({
    consoleUrl: 'http://localhost/feishu', signal: new AbortController().signal,
    observe: async () => ({ ...empty, configured: true, connection: { state: 'failed', message: 'Check credentials' } }),
    wait: async message => { expect(message).toContain('Check credentials'); return false },
    ask: async () => { throw new Error('no confirmation expected') },
    bind: async () => { throw new Error('must not bind') },
  })
  expect(result).toBe(false)
})

test('poll completion dismisses the waiting prompt', async () => {
  let dismissals = 0
  expect(await waitForSetup({
    ask: () => new Promise(() => {}), dismiss: () => { dismissals++ },
  }, 'Waiting', async () => true, new AbortController().signal, 1, 30)).toBe(true)
  expect(dismissals).toBe(1)
})

test('cancelling while a poll is in flight cannot advance setup', async () => {
  const cancel = new AbortController()
  let complete: (value: boolean) => void = () => {}
  const result = waitForSetup({ ask: () => new Promise(() => {}), dismiss: () => {} },
    'Waiting', () => new Promise(resolve => { complete = resolve }), cancel.signal, 1, 30)
  cancel.abort()
  complete(true)
  expect(await result).toBe(false)
})

test('deadline releases the overlay even if an observation never resolves', async () => {
  let dismissed = false
  await expect(waitForSetup({
    ask: () => new Promise(() => {}), dismiss: () => { dismissed = true },
  }, 'Waiting', () => new Promise(() => {}), new AbortController().signal, 1, 5)).rejects.toThrow('timed out')
  expect(dismissed).toBe(true)
})

test('timeout stops polling and releases the overlay', async () => {
  let dismissed = false
  await expect(waitForSetup({
    ask: () => new Promise(() => {}), dismiss: () => { dismissed = true },
  }, 'Waiting', async () => false, new AbortController().signal, 1, 0)).rejects.toThrow('timed out')
  expect(dismissed).toBe(true)
})
