import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import {
  dispatchHostToolCall,
  HOST_TOOL_SPECS_JSON,
  type AskUserAnswer,
  type AskUserParams,
  type HostToolCall,
  type HostToolExtension,
} from '../../src/features/host-tools.js'
import type { TaskPersistence } from '../../src/features/task/commit.js'
import { createTaskFlowState, type TaskFlowState } from '../../src/features/task/prompt.js'
import {
  createTaskExtension,
  normalizeTaskArguments,
  TASK_HOST_TOOL_SPECS_JSON,
} from '../../src/features/task/host-tool.js'
import {
  matchModelHint,
  type TaskModelDefaults,
  type TaskModelPicker,
  type TaskModelPickerRequest,
} from '../../src/features/task/model-picker.js'
import { BROADCAST_TARGET, TASK_RUNTIME_DEFAULT_MODEL, type ScheduledTask } from '../../src/features/task/types.js'

const task: ScheduledTask = {
  id: 'task1', revision: 4, name: 'Daily report', cron: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai', instruction: 'Prepare report', executor_id: 'exec1',
  model_policy: 'fixed', model_spec: 'evot-pro-anthropic:claude-opus-5', thinking_level: 'high',
  workspace_ref: '/work', delivery_channel: 'feishu', delivery_target: 'oc_chat1',
  timeout_seconds: 900, max_lateness_seconds: 14_400,
  enabled: true, next_run_at: 1_800_000_000_000, last_run: null,
}

const taskModel: TaskModelDefaults = {
  model_spec: 'evot-pro-anthropic:claude-opus-5',
  thinking_level: 'high',
  feishu_ready: true,
  feishu_target: 'oc_default',
  available_models: [
    {
      spec: 'evot-pro-anthropic:claude-opus-5',
      model: 'claude-opus-5',
      label: 'Claude Opus',
      group: 'Evot Premium',
      thinking_level: 'high',
    },
    {
      spec: 'evot-pro-anthropic:deepseek-v4.1-flash',
      model: 'deepseek-v4.1-flash',
      label: 'DeepSeek Flash',
      group: 'Evot Premium',
      thinking_level: 'medium',
    },
  ],
}

const answers: AskUserAnswer[] = [
  { header: 'Choice', question: 'Which option?', answer: 'First' },
]

async function collect(_params: AskUserParams): Promise<AskUserAnswer[]> {
  return answers
}

async function cancelAtConfirmation(params: AskUserParams): Promise<AskUserAnswer[]> {
  const question = params.questions[0]?.question ?? ''
  return [{ header: 'Task', question, answer: 'Cancel' }]
}

const pickDeepSeek: TaskModelPicker = async () => ({
  spec: 'evot-pro-anthropic:deepseek-v4.1-flash',
  thinkingLevel: 'medium',
})

const pickRuntimeDefault: TaskModelPicker = async () => ({ spec: TASK_RUNTIME_DEFAULT_MODEL })

interface DispatchOptions {
  defaults?: TaskModelDefaults
  flow?: TaskFlowState
  pickModel?: TaskModelPicker
  collectAnswers?: (params: AskUserParams) => Promise<AskUserAnswer[] | null>
  persist?: TaskPersistence
}

/** Dispatch a task tool exactly as the REPL does: through the generic
 *  dispatcher, with the task feature registered as an extension. */
function dispatch(call: HostToolCall, options: DispatchOptions = {}) {
  const collectAnswers = options.collectAnswers ?? cancelAtConfirmation
  const extension: HostToolExtension = createTaskExtension({
    flow: options.flow ?? createTaskFlowState('create'),
    defaults: async () => options.defaults ?? taskModel,
    pickModel: options.pickModel ?? (async () => null),
    collectAnswers,
    ...(options.persist ? { persist: options.persist } : {}),
  })
  return dispatchHostToolCall(call, collectAnswers, extension)
}

const createRequest = {
  name: 'Daily report',
  cron: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  instruction: 'Prepare report',
}

describe('host tools', () => {
  test('update identity is host-bound and unknown fields never reach the mutation', () => {
    const flow = createTaskFlowState('update', task)
    expect(() => normalizeTaskArguments({ task_id: 'another-task', revision: task.revision }, flow, taskModel)).toThrow('identity or revision')
    expect(() => normalizeTaskArguments({ task_id: task.id, revision: 999 }, flow, taskModel)).toThrow('identity or revision')
    const patch = normalizeTaskArguments({ name: 'Safe edit', executor_id: 'injected', idempotency_key: 'injected', unexpected: true }, flow, taskModel)
    expect(patch).toEqual({ name: 'Safe edit', task_id: task.id, revision: task.revision })
  })

  test('defaults read failure enters setup instead of bypassing the guide', async () => {
    let reads = 0
    let setups = 0
    const extension = createTaskExtension({
      flow: createTaskFlowState('create'),
      defaults: async () => { if (++reads === 1) throw new Error('temporary config failure'); return taskModel },
      ensureDelivery: async () => { setups++; return true },
      pickModel: pickDeepSeek,
      collectAnswers: cancelAtConfirmation,
    })
    const response = await dispatchHostToolCall({ tool_name: 'automation_task_create', tool_call_id: 'recover-defaults', arguments: createRequest }, collect, extension)
    expect(response.is_error).toBe(false)
    expect(setups).toBe(1)
    expect(reads).toBe(2)
  })
  test('missing delivery opens setup before model selection and resumes with push enabled', async () => {
    let ready = false
    let confirmation = ''
    const order: string[] = []
    const extension = createTaskExtension({
      flow: createTaskFlowState('create'),
      defaults: async () => ({ ...taskModel, feishu_ready: ready, feishu_target: ready ? 'oc_setup' : '' }),
      ensureDelivery: async () => { order.push('setup'); ready = true; return true },
      pickModel: async request => { order.push('model'); return pickDeepSeek(request) },
      collectAnswers: async params => { confirmation = params.questions[0]?.question ?? ''; return cancelAtConfirmation(params) },
    })
    const response = await dispatchHostToolCall({ tool_name: 'automation_task_create', tool_call_id: 'setup-first', arguments: { ...createRequest, delivery_channel: '' } }, collect, extension)
    expect(response.is_error).toBe(false)
    expect(order).toEqual(['setup', 'model'])
    expect(confirmation).toContain('Feishu · oc_setup')
    expect(confirmation).not.toContain('Local result only')
  })

  test('cancelling delivery setup ends creation without opening model or confirmation', async () => {
    const flow = createTaskFlowState('create')
    const extension = createTaskExtension({
      flow,
      defaults: async () => ({ ...taskModel, feishu_ready: false, feishu_target: '' }),
      ensureDelivery: async () => false,
      pickModel: async () => { throw new Error('must not pick') },
      collectAnswers: async () => { throw new Error('must not confirm') },
    })
    const call = { tool_name: 'automation_task_create', tool_call_id: 'setup-cancel', arguments: createRequest }
    const response = await dispatchHostToolCall(call, collect, extension)
    expect(response.content[0]?.text).toContain('Nothing was created')
    expect(flow.mutationAttempted).toBe(true)
    expect((await dispatchHostToolCall(call, collect, extension)).content[0]?.text).toContain('already attempted')
  })
  test('publishes task tools only in task flows with human-facing model schema', () => {
    expect(JSON.parse(HOST_TOOL_SPECS_JSON).map((spec: { name: string }) => spec.name)).toEqual(['ask_user'])
    const specs = JSON.parse(TASK_HOST_TOOL_SPECS_JSON)
    expect(specs.map((spec: { name: string }) => spec.name)).toEqual([
      'ask_user',
      'automation_task_create',
      'automation_task_update',
    ])
    for (const spec of specs.filter((item: { name: string }) => item.name.startsWith('automation_task_'))) {
      const properties = spec.parameters_schema.properties
      expect(properties.model.description).toContain('human model name')
      expect(properties).not.toHaveProperty('model_spec')
      expect(properties).not.toHaveProperty('model_policy')
      // The runner clamps to this range; advertising it stops a stored task
      // from quietly asking for a timeout that will never be honored.
      expect(properties.timeout_seconds.minimum).toBe(30)
      expect(properties.timeout_seconds.maximum).toBe(3600)
    }
  })

  test('a clear create request goes directly to final confirmation', async () => {
    let confirmation = ''
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-clear',
      arguments: { ...createRequest, model: 'DeepSeek Flash', delivery_channel: '' },
    }, {
      pickModel: pickDeepSeek,
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })

    expect(response.is_error).toBe(false)
    expect(response.content[0]?.text).toContain('cancelled')
    expect(confirmation).toContain('model: DeepSeek Flash · medium')
    expect(confirmation).not.toContain('thinking_level:')
    expect(confirmation).not.toContain('evot-pro-anthropic')
  })

  test('agent-supplied model fields never bypass the picker', async () => {
    let confirmation = ''
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-injected-model',
      arguments: {
        ...createRequest,
        model: 'DeepSeek Flash',
        model_policy: 'default',
        model_spec: 'agent-guessed:wrong-model',
        thinking_level: 'max',
      },
    }, {
      // The user lands on Claude in the catalog, overriding every hint above.
      pickModel: async () => ({ spec: taskModel.model_spec, thinkingLevel: 'high' }),
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })

    expect(response.is_error).toBe(false)
    expect(confirmation).toContain('model: Claude Opus · high')
    expect(confirmation).not.toContain('wrong-model')
    expect(confirmation).not.toContain('Device default')
  })

  test('a picked model missing from the catalog fails instead of saving a stale spec', async () => {
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-vanished-model',
      arguments: createRequest,
    }, {
      pickModel: async () => ({ spec: 'evot-pro:removed-model' }),
      collectAnswers: async () => {
        throw new Error('confirmation must not open')
      },
    })

    expect(response.is_error).toBe(true)
    expect(response.content[0]?.text).toContain('no longer available')
  })

  test('editing starts on the persisted Task model and saves the model chosen from that row', async () => {
    let confirmation = ''
    let confirmationCalls = 0
    let request: TaskModelPickerRequest | undefined
    const liveEvotModel = {
      ...taskModel,
      model_spec: 'evot-pro-anthropic:deepseek-v4.1-flash',
      thinking_level: 'medium',
    }
    const response = await dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: 'update-natural-model',
      arguments: { task_id: task.id, revision: task.revision, model: '改成 deepseek flash 模型' },
    }, {
      defaults: liveEvotModel,
      flow: createTaskFlowState('update', task),
      pickModel: async pickerRequest => {
        request = pickerRequest
        // Simulates moving from the persisted Claude row to DeepSeek and Enter.
        return pickDeepSeek(pickerRequest)
      },
      collectAnswers: async params => {
        confirmationCalls++
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })

    expect(response.is_error).toBe(false)
    expect(request).toEqual({
      preferredSpec: task.model_spec,
      preferredThinkingLevel: task.thinking_level,
    })
    expect(confirmationCalls).toBe(1)
    expect(confirmation).toContain('model: Claude Opus · high → DeepSeek Flash · medium')
    expect(confirmation).not.toContain('schedule:')
    expect(confirmation).not.toContain('instruction:')
    expect(confirmation).not.toContain('evot-pro-anthropic')
  })

  test('feedback typed at the confirmation reopens the change instead of cancelling it', async () => {
    // The user reads the diff and objects ("why so many new lines?"). That is
    // a note on the proposal, not a Cancel: the model must hear it verbatim
    // and may call the tool again in the same flow.
    const flow = createTaskFlowState('update', { ...task, instruction: 'Prepare report' })
    const answersSeen: string[] = []
    const persisted: unknown[] = []
    const persist: TaskPersistence = {
      create: async () => { throw new Error('not creating') },
      update: async (_id, body) => { persisted.push(body); return { task: { ...task, instruction: String(body.instruction) }, next_runs: [] } },
    }
    const respond = async (patch: Record<string, unknown>, answer: string) => dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: `update-${answersSeen.length}`,
      arguments: { task_id: task.id, revision: task.revision, ...patch },
    }, {
      flow,
      persist,
      collectAnswers: async params => {
        answersSeen.push(params.questions[0]?.question ?? '')
        return [{ header: 'Task', question: '', answer }]
      },
    })

    const first = await respond({ instruction: 'Prepare a long, long, long report' }, '不是加到6就可以了，为啥要新增这么多呢')
    expect(first.is_error).toBe(false)
    expect(first.content[0]?.text).toContain('不是加到6就可以了，为啥要新增这么多呢')
    expect(first.content[0]?.text).toContain('call automation_task_update again')
    expect(first.content[0]?.text).not.toContain('cancelled')
    expect(flow.mutationAttempted).toBe(false)
    expect(persisted).toHaveLength(0)

    const second = await respond({ instruction: 'Prepare report (6)' }, 'Confirm')
    expect(second.is_error).toBe(false)
    expect(second.content[0]?.text).toContain('Updated')
    expect(persisted).toHaveLength(1)
    expect(answersSeen).toHaveLength(2)
  })

  test('a schedule edit takes the same revise loop as an instruction edit', async () => {
    const flow = createTaskFlowState('update', task)
    const persisted: Record<string, unknown>[] = []
    const persist: TaskPersistence = {
      create: async () => { throw new Error('not creating') },
      update: async (_id, body) => { persisted.push(body as Record<string, unknown>); return { task: { ...task, ...body } as typeof task, next_runs: [] } },
    }
    const questions: string[] = []
    const respond = async (patch: Record<string, unknown>, answer: string) => dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: `sched-${questions.length}`,
      arguments: { task_id: task.id, revision: task.revision, ...patch },
    }, {
      flow,
      persist,
      collectAnswers: async params => {
        questions.push(params.questions[0]?.question ?? '')
        return [{ header: 'Task', question: '', answer }]
      },
    })

    const first = await respond({ cron: '0 8 * * *' }, '要 8 点半，不是 8 点')
    expect(questions[0]).toContain('schedule: ')
    expect(questions[0]).toContain('Not quite right? Type what to change')
    expect(first.content[0]?.text).toContain('要 8 点半，不是 8 点')
    expect(first.content[0]?.text).toContain('call automation_task_update again')
    expect(persisted).toHaveLength(0)

    const second = await respond({ cron: '30 8 * * *' }, 'Confirm')
    expect(second.content[0]?.text).toContain('Updated')
    expect(persisted).toEqual([expect.objectContaining({ cron: '30 8 * * *' })])
  })

  test('Cancel at the confirmation still ends the flow', async () => {
    const flow = createTaskFlowState('update', task)
    const response = await dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: 'update-cancel',
      arguments: { task_id: task.id, revision: task.revision, instruction: 'x' },
    }, { flow, collectAnswers: cancelAtConfirmation })
    expect(response.content[0]?.text).toContain('cancelled by the user')
    expect(flow.mutationAttempted).toBe(true)
  })

  test('an instruction edit is confirmed as a git-style diff, not the text twice', async () => {
    let confirmation = ''
    const before = 'Prepare report'
    const after = 'Prepare the weekly report'
    const response = await dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: 'update-instruction',
      arguments: { task_id: task.id, revision: task.revision, instruction: after },
    }, {
      flow: createTaskFlowState('update', { ...task, instruction: before }),
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })
    expect(response.is_error).toBe(false)
    const plain = stripAnsi(confirmation)
    expect(plain).toContain('instruction (+1 −1):')
    // One removed and one added line with a line-number gutter, as the Edit
    // tool shows its diffs; never `old → new` with both paragraphs in full.
    expect(plain).toMatch(/\n\s*1 -Prepare report\n\s*1 \+Prepare the weekly report/)
    expect(plain).not.toContain('→ Prepare the weekly report')
    expect(plain).not.toContain('model:')
  })

  test('a create hint preselects a catalog row, and the picker choice still wins', async () => {
    let request: TaskModelPickerRequest | undefined
    let confirmation = ''
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-picker-authority',
      arguments: { ...createRequest, model: 'DeepSeek Flash' },
    }, {
      pickModel: async pickerRequest => {
        request = pickerRequest
        return { spec: taskModel.model_spec, thinkingLevel: 'high' }
      },
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })

    expect(response.is_error).toBe(false)
    expect(request).toEqual({
      preferredSpec: 'evot-pro-anthropic:deepseek-v4.1-flash',
      preferredThinkingLevel: 'medium',
    })
    expect(confirmation).toContain('model: Claude Opus · high')
    expect(confirmation).not.toContain('model: DeepSeek Flash')
  })

  test('create without a model still requires the catalog and preselects the live model', async () => {
    let request: TaskModelPickerRequest | undefined
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-picker-required',
      arguments: createRequest,
    }, {
      pickModel: async pickerRequest => {
        request = pickerRequest
        return { spec: taskModel.model_spec, thinkingLevel: taskModel.thinking_level }
      },
    })

    expect(response.is_error).toBe(false)
    expect(request).toEqual({
      preferredSpec: taskModel.model_spec,
      preferredThinkingLevel: taskModel.thinking_level,
    })
  })

  test('an unrecognizable model hint opens the catalog on the live model', async () => {
    let request: TaskModelPickerRequest | undefined
    await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-unknown-hint',
      arguments: { ...createRequest, model: 'a model name that is not in the catalog' },
    }, {
      pickModel: async pickerRequest => {
        request = pickerRequest
        return { spec: taskModel.model_spec }
      },
    })

    expect(request?.preferredSpec).toBe(taskModel.model_spec)
  })

  test('model hints match on case, spacing, and surrounding prose', () => {
    const models = taskModel.available_models ?? []
    expect(matchModelHint('DeepSeek Flash', models)?.label).toBe('DeepSeek Flash')
    expect(matchModelHint('deepseek-v4.1-flash', models)?.label).toBe('DeepSeek Flash')
    expect(matchModelHint('改成 deepseek flash 模型', models)?.label).toBe('DeepSeek Flash')
    // Ambiguous and unknown hints defer to the picker rather than guessing.
    expect(matchModelHint('flash', [
      ...models,
      { spec: 'other:another-flash', model: 'another-flash', label: 'Another Flash', thinking_level: 'low' },
    ])).toBeUndefined()
    expect(matchModelHint('nothing like this', models)).toBeUndefined()
    expect(matchModelHint('   ', models)).toBeUndefined()
  })

  test('a model added while the picker is open uses the refreshed catalog metadata', async () => {
    let confirmation = ''
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-refreshed-model',
      arguments: createRequest,
    }, {
      pickModel: async () => ({
        spec: 'evot-pro-openai:new-after-sync',
        model: 'new-after-sync',
        label: 'New After Sync',
        group: 'Evot Premium',
        defaultThinkingLevel: 'medium',
        thinkingLevel: 'high',
      }),
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })

    expect(response.is_error).toBe(false)
    expect(confirmation).toContain('model: New After Sync · high')
    expect(confirmation).not.toContain('new-after-sync')
  })

  test('non-model edits do not open the catalog', async () => {
    let pickerCalls = 0
    let confirmation = ''
    const response = await dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: 'update-name-only',
      arguments: { task_id: task.id, revision: task.revision, name: 'Renamed report' },
    }, {
      flow: createTaskFlowState('update', task),
      pickModel: async () => {
        pickerCalls++
        return null
      },
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })

    expect(response.is_error).toBe(false)
    expect(pickerCalls).toBe(0)
    expect(confirmation).toContain('name: Daily report → Renamed report')
    expect(confirmation).not.toContain('model:')
    expect(confirmation).not.toContain('schedule:')
  })

  test('cancelling the model picker cancels the mutation before final confirmation', async () => {
    const flow = createTaskFlowState('create')
    let confirmations = 0
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'cancel-model-picker',
      arguments: createRequest,
    }, {
      flow,
      pickModel: async () => null,
      collectAnswers: async () => {
        confirmations++
        return []
      },
    })

    expect(response.is_error).toBe(false)
    expect(response.content[0]?.text).toContain('cancelled during model selection')
    expect(confirmations).toBe(0)
    expect(flow.mutationAttempted).toBe(true)
    expect(flow.mutationError).toBe('model selection cancelled by user')
  })

  test('update confirmation shows only the requested change', async () => {
    let confirmation = ''
    const response = await dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: 'update-model',
      arguments: { task_id: task.id, revision: task.revision, model: 'device default' },
    }, {
      flow: createTaskFlowState('update', task),
      pickModel: pickRuntimeDefault,
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })

    expect(response.is_error).toBe(false)
    expect(confirmation).toContain('model: Claude Opus · high → Device default at run time')
    expect(confirmation).not.toContain('schedule:')
    expect(confirmation).not.toContain('delivery:')
    expect(confirmation).not.toContain('instruction:')
    expect(confirmation).not.toContain(task.model_spec)
  })

  test('the model is never taken from tool arguments', () => {
    const patch = normalizeTaskArguments({
      task_id: task.id,
      revision: task.revision,
      model: 'DeepSeek Flash',
      model_policy: 'default',
      model_spec: 'agent-guessed:wrong-model',
      thinking_level: 'max',
    }, createTaskFlowState('update', task), taskModel)

    expect(patch).not.toHaveProperty('model')
    expect(patch).not.toHaveProperty('model_policy')
    expect(patch).not.toHaveProperty('model_spec')
    expect(patch).not.toHaveProperty('thinking_level')
  })

  test('delivery resolves from device config, never from a guess', () => {
    const flow = () => createTaskFlowState('update', task)
    // Explicit disable stays local.
    expect(normalizeTaskArguments({
      task_id: task.id, revision: task.revision, delivery_channel: '',
    }, flow(), taskModel)).toMatchObject({ delivery_channel: '', delivery_target: '' })

    // Feishu without a target uses the device's default notification chat.
    expect(normalizeTaskArguments({
      task_id: task.id, revision: task.revision, delivery_channel: 'feishu',
    }, flow(), taskModel)).toMatchObject({
      delivery_channel: 'feishu',
      delivery_target: 'oc_default',
    })

    // An explicit chat wins over the device default.
    expect(normalizeTaskArguments({
      task_id: task.id, revision: task.revision,
      delivery_channel: 'feishu', delivery_target: 'oc_explicit',
    }, flow(), taskModel)).toMatchObject({ delivery_target: 'oc_explicit' })

    // Broadcast is honored only because the caller asked for it by name.
    expect(normalizeTaskArguments({
      task_id: task.id, revision: task.revision,
      delivery_channel: 'feishu', delivery_target: BROADCAST_TARGET,
    }, flow(), taskModel)).toMatchObject({ delivery_target: BROADCAST_TARGET })

    // Creating with no delivery mentioned opts in only when a chat exists.
    expect(normalizeTaskArguments(createRequest, createTaskFlowState('create'), taskModel))
      .toMatchObject({ delivery_channel: 'feishu', delivery_target: 'oc_default' })
    expect(() => normalizeTaskArguments(
      createRequest,
      createTaskFlowState('create'),
      { ...taskModel, feishu_target: '' },
    )).toThrow('default notification chat ID')
  })

  test('requesting Feishu with no reachable chat fails at creation, not at delivery time', async () => {
    const response = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'create-undeliverable',
      arguments: { ...createRequest, delivery_channel: 'feishu' },
    }, {
      defaults: { ...taskModel, feishu_target: '' },
      pickModel: pickDeepSeek,
      collectAnswers: async () => {
        throw new Error('confirmation must not open')
      },
    })

    expect(response.is_error).toBe(true)
    expect(response.content[0]?.text).toContain('Feishu setup is required')
  })

  test('final confirmation names the destination chat', async () => {
    let confirmation = ''
    await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'confirm-delivery',
      arguments: { ...createRequest, model: 'DeepSeek Flash' },
    }, {
      pickModel: pickDeepSeek,
      collectAnswers: async params => {
        confirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })
    expect(confirmation).toContain('delivery: Feishu · oc_default')

    let broadcastConfirmation = ''
    await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'confirm-broadcast',
      arguments: { ...createRequest, delivery_channel: 'feishu', delivery_target: BROADCAST_TARGET },
    }, {
      pickModel: pickDeepSeek,
      collectAnswers: async params => {
        broadcastConfirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })
    expect(broadcastConfirmation).toContain('delivery: Feishu · all bot direct conversations')

    let localConfirmation = ''
    await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'confirm-local',
      arguments: createRequest,
    }, {
      defaults: { ...taskModel, feishu_target: '' },
      pickModel: pickDeepSeek,
      collectAnswers: async params => {
        localConfirmation = params.questions[0]?.question ?? ''
        return cancelAtConfirmation(params)
      },
    })
    expect(localConfirmation).toBe('')
  })

  test('a confirmed or cancelled mutation cannot reopen confirmation in the same flow', async () => {
    const flow = createTaskFlowState('update', task)
    let confirmations = 0
    const first = await dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: 'cancel-once',
      arguments: { task_id: task.id, revision: task.revision, name: 'New report' },
    }, {
      flow,
      collectAnswers: async params => {
        confirmations++
        return cancelAtConfirmation(params)
      },
    })
    expect(first.is_error).toBe(false)
    expect(first.content[0]?.text).toContain('cancelled')
    expect(flow.mutationAttempted).toBe(true)

    const second = await dispatch({
      tool_name: 'automation_task_update',
      tool_call_id: 'retry-after-cancel',
      arguments: { task_id: task.id, revision: task.revision, name: 'New report' },
    }, {
      flow,
      collectAnswers: async () => {
        confirmations++
        return []
      },
    })
    expect(confirmations).toBe(1)
    expect(second.is_error).toBe(false)
    expect(second.content[0]?.text).toContain('Do not retry automatically')

    const failed = createTaskFlowState('create')
    failed.mutationAttempted = true
    failed.mutationError = '/v1/tasks: invalid schedule'
    const blocked = await dispatch({
      tool_name: 'automation_task_create',
      tool_call_id: 'retry-after-failure',
      arguments: { name: 'Say hi', cron: '* * * * *', timezone: 'Asia/Shanghai', instruction: 'hi' },
    }, {
      flow: failed,
      collectAnswers: async () => {
        throw new Error('confirmation must not reopen')
      },
    })
    expect(blocked.is_error).toBe(false)
    expect(blocked.content[0]?.text).toContain(failed.mutationError)
  })

  test('task tools stay scoped to the matching flow and are absent outside /task', async () => {
    const call: HostToolCall = {
      tool_name: 'automation_task_update', tool_call_id: 'wrong',
      arguments: { task_id: task.id, revision: task.revision, name: 'Renamed' },
    }
    const wrong = await dispatch(call, { flow: createTaskFlowState('create') })
    expect(wrong.is_error).toBe(true)
    expect(wrong.content[0]?.text).toContain('only allows create')

    // Without the task extension registered, the tool does not exist at all.
    const absent = await dispatchHostToolCall(call, cancelAtConfirmation)
    expect(absent.is_error).toBe(true)
    expect(absent.content[0]?.text).toContain('Unknown host tool')
  })

  test('dispatches ask_user and handles aliases, cancellation, and errors', async () => {
    const response = await dispatchHostToolCall({
      tool_name: 'ask_user', tool_call_id: 'c1', arguments: { questions: [] },
    }, collect)
    expect(response.is_error).toBe(false)
    expect(response.content[0]?.text).toContain('Which option? → First')

    const alias = await dispatchHostToolCall({
      tool_name: 'AskUser', tool_call_id: 'c2', arguments: { questions: [] },
    }, collect)
    expect(alias.is_error).toBe(false)

    const cancelled = await dispatchHostToolCall({
      tool_name: 'ask_user', tool_call_id: 'c3', arguments: { questions: [] },
    }, async () => null)
    expect(cancelled.is_error).toBe(true)

    const failed = await dispatchHostToolCall({
      tool_name: 'ask_user', tool_call_id: 'c4', arguments: { questions: [] },
    }, async () => { throw new Error('kaboom') })
    expect(failed.content[0]?.text).toBe('kaboom')
  })
})
