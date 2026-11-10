import { expect, test } from 'bun:test'
import { recoverSetup } from '../../src/features/channels/setup-recovery.js'
import { ensureFeishuDelivery } from '../../src/features/channels/feishu/setup.js'
import { observeFeishu } from '../../src/features/channels/feishu/client.js'
import { createTaskExtension } from '../../src/features/task/host-tool.js'
import { createTaskFlowState } from '../../src/features/task/prompt.js'
import { TASK_RUNTIME_DEFAULT_MODEL } from '../../src/features/task/types.js'
import { dispatchHostToolCall } from '../../src/features/host-tools.js'

const signal = () => new AbortController().signal

test('missing endpoint shows recovery UI, then resumes the same action after upgrade', async () => {
  let upgraded = false
  let prompts = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return upgraded
      ? Response.json({ configured: true, revision: 'v1', default_chat_id: 'oc_me', chats: [], connection: { state: 'connected', message: '' } })
      : new Response('', { status: 404 })
  } })
  try {
    const address = `http://127.0.0.1:${server.port}`
    const state = await recoverSetup({
      signal: signal(), consoleUrl: `${address}/feishu`,
      ask: async questions => {
        prompts++
        const q = questions[0]!
        expect(q.header).toBe('Feishu setup')
        expect(q.question).toContain(`${address}/feishu`)
        expect(q.question).toContain('current evot build')
        expect(q.question).toContain('Your task draft is kept')
        upgraded = true
        return [{ header: q.header, question: q.question, answer: 'Continue setup' }]
      },
    }, () => observeFeishu(address))
    expect(state?.default_chat_id).toBe('oc_me')
    expect(prompts).toBe(1)
  } finally { await server.stop(true) }
})

test('server startup failure is guided before any onboarding request', async () => {
  let prompts = 0
  const result = await ensureFeishuDelivery({
    signal: signal(), consoleUrl: 'http://localhost:8082/feishu',
    envFile: () => '/tmp/test.env',
    console: async () => { throw new Error('Console unavailable') },
    ask: async questions => {
      prompts++
      expect(questions[0]!.question).toContain('Console unavailable')
      expect(questions[0]!.question).toContain('/feishu')
      return null
    },
    wait: async () => { throw new Error('must not poll') },
  })
  expect(prompts).toBe(1)
  expect(result).toBe(false)
})

test('repeated failure stays in recovery until cancellation, with no automatic retries', async () => {
  let attempts = 0
  let prompts = 0
  const result = await recoverSetup({
    signal: signal(), consoleUrl: 'http://localhost:8082/feishu',
    ask: async () => {
      expect(attempts).toBe(++prompts)
      return [{ header: '', question: '', answer: prompts === 1 ? 'Continue setup' : 'Cancel' }]
    },
  }, async () => { attempts++; throw new Error('Connection refused') })
  expect(result).toBeNull()
  expect(attempts).toBe(2)
})

test('aborting while awaiting observation does not open recovery or report success', async () => {
  const controller = new AbortController()
  const result = await recoverSetup({
    signal: controller.signal, consoleUrl: 'http://localhost/feishu',
    ask: async () => { throw new Error('must not open') },
  }, async () => { controller.abort(); return true })
  expect(result).toBeNull()
})

test('task draft survives setup failure and recovery in a single tool call', async () => {
  let ready = false
  let attempts = 0
  const flow = createTaskFlowState('create')
  let confirmation = ''
  const extension = createTaskExtension({
    flow,
    defaults: async () => ({ model_spec: '', thinking_level: '', feishu_ready: ready, feishu_target: ready ? 'oc_me' : '' }),
    ensureDelivery: async () => (await recoverSetup({
      signal: signal(), consoleUrl: 'http://localhost/feishu',
      ask: async () => {
        expect(flow.mutationAttempted).toBe(false)
        return [{ header: '', question: '', answer: 'Continue setup' }]
      },
    }, async () => {
      if (++attempts === 1) throw new Error('Console needs update')
      ready = true
      return true
    })) ?? false,
    pickModel: async () => ({ spec: TASK_RUNTIME_DEFAULT_MODEL }),
    collectAnswers: async params => {
      confirmation = params.questions[0]!.question
      return [{ header: '', question: '', answer: 'Cancel' }]
    },
  })
  const response = await dispatchHostToolCall({
    tool_name: 'automation_task_create', tool_call_id: 'same-draft',
    arguments: { name: 'Minute greeting', cron: '* * * * *', timezone: 'Asia/Shanghai', instruction: 'hi' },
  }, async () => null, extension)
  expect(response.is_error).toBe(false)
  expect(confirmation).toContain('Minute greeting')
  expect(confirmation).toContain('* * * * *')
  expect(confirmation).toContain('Feishu · oc_me')
  expect(attempts).toBe(2)
})
